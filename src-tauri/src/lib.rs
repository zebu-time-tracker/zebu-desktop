mod tray_icon;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
#[cfg(target_os = "linux")]
use tauri::menu::{Menu, MenuItem};
use tauri_plugin_positioner::{Position, WindowExt};

/// Whether the app currently shows in the dock / app switcher.
static DOCK_MODE: AtomicBool = AtomicBool::new(false);
/// "Hide when changing focus" preference (default on).
static HIDE_ON_BLUR: AtomicBool = AtomicBool::new(true);
/// Whether a timer is running, as the frontend last reported it through
/// `set_tray_title` (which it calls on every state change). The tray click
/// handler branches on this and has to answer the click there and then, so it
/// cannot afford to ask the webview and wait for a reply.
static TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

/// Linux only: our per-pixel pill icon can't render as a normal (square)
/// tray icon there, and the tray tooltip API is a documented no-op on that
/// platform — the running project/elapsed time goes in this disabled menu
/// line instead. See the tray setup in `run()` for why Linux gets a menu at
/// all: Tauri's own docs say the click event is "Unsupported" on Linux (never
/// emitted even though the icon shows), so a menu is the only way the icon
/// can be interacted with there.
#[cfg(target_os = "linux")]
static TRAY_STATUS_ITEM: std::sync::OnceLock<MenuItem<tauri::Wry>> = std::sync::OnceLock::new();

/// Seconds since the last keyboard/mouse input, for Harvest-style idle
/// detection. 0 when the platform can't tell (detection simply stays off).
#[tauri::command]
fn idle_seconds() -> u64 {
    user_idle::UserIdle::get_time()
        .map(|t| t.as_seconds())
        .unwrap_or(0)
}

/// Show the popover hanging from the menubar icon. The positioner only knows
/// the tray's place once a tray event has been seen; straight after launch
/// (or when the idle watcher fires before any click) it errors, so fall back
/// to asking the tray for its rect directly. Never lets the window land in
/// the middle of the screen.
fn show_popover(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.move_window(Position::TrayCenter).is_err() {
        if let (Some(Ok(Some(rect))), Ok(win)) = (app.tray_by_id("main").map(|t| t.rect()), window.outer_size()) {
            // tray-icon reports physical pixels already (same assumption as the positioner)
            let pos = rect.position.to_physical::<f64>(1.0);
            let size = rect.size.to_physical::<f64>(1.0);
            let x = pos.x + size.width / 2.0 - win.width as f64 / 2.0;
            #[cfg(target_os = "macos")]
            let y = pos.y;
            #[cfg(not(target_os = "macos"))]
            let y = pos.y + size.height;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Open the popover, or put it away when it is already up. This is what a
/// click on the menubar icon used to do; it is the secondary click's job now
/// (see the tray event handler in `run()`).
fn toggle_popover(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        hide_insights(app); // the panel belongs to the popover
    } else {
        show_popover(app);
    }
}

/// Idle threshold in seconds; 0 = detection off (no timer running, or the
/// preference is disabled). The frontend keeps this current.
static IDLE_THRESHOLD_S: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
fn set_idle_threshold(seconds: u64) {
    IDLE_THRESHOLD_S.store(seconds, Ordering::SeqCst);
}

/// How long the user was away, given two samples of the OS idle counter
/// taken `gap_s` seconds of wall-clock time apart. None while the stretch
/// continues (or nothing happened); Some(seconds) the moment input resumes.
///
/// Wall-clock gaps matter as much as the counter: the machine sleeping, or
/// the process being suspended, shows up as a gap far longer than the
/// sampling interval, and macOS's counter does not tick during sleep — so a
/// lid closed for two hours reads as a two-hour absence either way.
fn away_seconds(prev_idle_s: u64, gap_s: u64, idle_s: u64) -> Option<u64> {
    let still_idle = idle_s + 3 >= prev_idle_s + gap_s; // counter kept climbing (±jitter)
    if still_idle {
        return None;
    }
    let away = (prev_idle_s + gap_s).saturating_sub(idle_s);
    (away > 0).then_some(away)
}

/// Watches the OS idle counter from a native thread (webview timers are
/// throttled or paused while the popover is hidden). When input resumes
/// after at least the threshold, shows the popover and emits `idle-return`
/// with when the absence started and how long it lasted.
fn spawn_idle_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut prev_idle = idle_seconds();
        let mut prev_at = SystemTime::now();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = SystemTime::now();
            let gap = now.duration_since(prev_at).unwrap_or_default().as_secs();
            let idle = idle_seconds();
            let threshold = IDLE_THRESHOLD_S.load(Ordering::SeqCst);

            if threshold > 0 {
                if let Some(away) = away_seconds(prev_idle, gap, idle) {
                    if away >= threshold {
                        let started_ms = prev_at
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0)
                            .saturating_sub(prev_idle * 1000);
                        // open the list first: the frontend answers this event
                        // by measuring the running row, which only sits where
                        // the prompt should point once the window has moved
                        show_popover(&app);
                        let _ = app.emit("idle-return", serde_json::json!({ "started_at_ms": started_ms, "seconds": away }));
                    }
                }
            }
            prev_idle = idle;
            prev_at = now;
        }
    });
}

// ---- idle prompt window ----------------------------------------------------
//
// The prompt used to be a callout inside the timer list's DOM, which the main
// window's frame clipped: with the running entry near the bottom of a long
// list it hung below the visible area and had to be scrolled to. It is its own
// borderless always-on-top window now, placed against the running entry's stop
// button but clamped to the monitor's work area, so it is never cut off
// wherever that entry sits.

const IDLE_LABEL: &str = "idle";
/// Logical size of the prompt: the width is fixed, the height is what the
/// webview measures once the (translated) text has been laid out.
///
/// The width is set by the two side-by-side questions in `IdlePrompt.vue`:
/// each column needs (330 - 14px padding ×2 - 1px border ×2 - 10px gap) / 2 =
/// 145px, and the longest question in any locale measures ~136px (nl
/// "Inactieve tijd verwijderen?", pt "Remover o tempo inativo?"), so every
/// catalog keeps both questions and both Yes/No pairs on one line.
const IDLE_WIDTH: f64 = 330.0;
const IDLE_HEIGHT: f64 = 220.0;
/// Breathing room between the anchor and the prompt, in logical pixels.
const IDLE_GAP: f64 = 6.0;

/// A rectangle in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct ScreenRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// What the prompt hangs from, as the frontend measured it: CSS pixels
/// relative to the main window's webview (which fills the undecorated window).
#[derive(serde::Deserialize)]
struct AnchorRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The absence currently being asked about. `None` once it has been answered.
struct IdlePrompt {
    minutes: u64,
    anchor: Option<ScreenRect>,
}
static IDLE_PROMPT: Mutex<Option<IdlePrompt>> = Mutex::new(None);

fn idle_prompt_pending() -> bool {
    IDLE_PROMPT.lock().map(|p| p.is_some()).unwrap_or(false)
}

/// Where to put a `size` window so it hangs off `anchor` and still fits the
/// screen: centred under the anchor, flipped above it when there is no room
/// below, then clamped into the work area. All values are physical pixels.
fn prompt_position(anchor: ScreenRect, size: (f64, f64), work: ScreenRect, gap: f64) -> (f64, f64) {
    let (width, height) = size;
    let below = anchor.y + anchor.height + gap;
    let above = anchor.y - height - gap;
    let bottom = work.y + work.height;
    let fits_below = below + height <= bottom;
    let fits_above = above >= work.y;
    let y = if fits_below || !fits_above { below } else { above };
    let x = anchor.x + anchor.width / 2.0 - width / 2.0;
    (
        x.clamp(work.x, (work.x + work.width - width).max(work.x)),
        y.clamp(work.y, (bottom - height).max(work.y)),
    )
}

/// The visible area of the display holding a point — the whole virtual desktop
/// when no monitor can be identified, so nothing gets clamped away blindly.
fn work_area(app: &tauri::AppHandle, x: f64, y: f64) -> ScreenRect {
    let monitor = app
        .monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let area = m.work_area();
            ScreenRect {
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            }
        }
        None => ScreenRect { x: -1e6, y: -1e6, width: 2e6, height: 2e6 },
    }
}

/// The frontend's rect turned into screen coordinates. None when the main
/// window is hidden — an anchor no one can see points nowhere.
fn anchor_on_screen(app: &tauri::AppHandle, anchor: AnchorRect) -> Option<ScreenRect> {
    let window = app.get_webview_window("main")?;
    if !window.is_visible().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let origin = window.outer_position().ok()?;
    Some(ScreenRect {
        x: origin.x as f64 + anchor.x * scale,
        y: origin.y as f64 + anchor.y * scale,
        width: anchor.width * scale,
        height: anchor.height * scale,
    })
}

/// Fallback anchor: the menubar icon, the same place the popover hangs from.
fn tray_anchor(app: &tauri::AppHandle) -> Option<ScreenRect> {
    let rect = app.tray_by_id("main")?.rect().ok()??;
    // tray-icon reports physical pixels already (same assumption as show_popover)
    let position = rect.position.to_physical::<f64>(1.0);
    let size = rect.size.to_physical::<f64>(1.0);
    Some(ScreenRect { x: position.x, y: position.y, width: size.width, height: size.height })
}

/// Size the prompt to its content, put it where it fits, and show it.
fn place_idle_prompt(app: &tauri::AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(IDLE_LABEL) else {
        return;
    };
    let _ = window.set_size(LogicalSize::new(IDLE_WIDTH, height));
    let scale = window.scale_factor().unwrap_or(1.0);
    let anchor = IDLE_PROMPT
        .lock()
        .ok()
        .and_then(|p| p.as_ref().and_then(|p| p.anchor))
        .or_else(|| tray_anchor(app));
    if let Some(anchor) = anchor {
        let area = work_area(app, anchor.x + anchor.width / 2.0, anchor.y);
        let (x, y) = prompt_position(anchor, (IDLE_WIDTH * scale, height * scale), area, IDLE_GAP * scale);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Open the prompt for an absence. Called by the frontend, which owns the
/// decision to ask at all (a timer must be running, and only one prompt at a
/// time) and measures the running entry's stop button as the anchor.
///
/// The window is created hidden: it reveals itself through `fit_idle_prompt`
/// once its text is laid out, so it never flashes at the wrong size. The
/// watchdog covers a webview that never gets that far.
#[tauri::command]
fn show_idle_prompt(app: tauri::AppHandle, minutes: u64, anchor: Option<AnchorRect>) {
    let anchor = anchor.and_then(|a| anchor_on_screen(&app, a));
    if let Ok(mut prompt) = IDLE_PROMPT.lock() {
        *prompt = Some(IdlePrompt { minutes, anchor });
    }
    if app.get_webview_window(IDLE_LABEL).is_some() {
        // reused window: it is already mounted, so tell it to re-read and re-fit
        let _ = app.emit_to(IDLE_LABEL, "idle-prompt-show", ());
    } else {
        let _ = WebviewWindowBuilder::new(&app, IDLE_LABEL, WebviewUrl::App("index.html#idle".into()))
            .title("Zebu")
            .inner_size(IDLE_WIDTH, IDLE_HEIGHT)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            .visible(false)
            .focused(false)
            .build();
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let hidden = app
            .get_webview_window(IDLE_LABEL)
            .and_then(|w| w.is_visible().ok())
            .map(|visible| !visible)
            .unwrap_or(false);
        if hidden && idle_prompt_pending() {
            place_idle_prompt(&app, IDLE_HEIGHT);
        }
    });
}

/// The absence the prompt window should ask about, in whole minutes.
#[tauri::command]
fn idle_prompt_data() -> Option<u64> {
    IDLE_PROMPT.lock().ok().and_then(|p| p.as_ref().map(|p| p.minutes))
}

/// The prompt reporting the height its content needs; also what reveals it.
#[tauri::command]
fn fit_idle_prompt(app: tauri::AppHandle, height: f64) {
    place_idle_prompt(&app, height.clamp(120.0, 400.0));
}

/// The two answers, handed back to the main window, which owns what they mean.
#[tauri::command]
fn resolve_idle_prompt(app: tauri::AppHandle, remove: bool, stop: bool) {
    if let Ok(mut prompt) = IDLE_PROMPT.lock() {
        *prompt = None;
    }
    if let Some(window) = app.get_webview_window(IDLE_LABEL) {
        let _ = window.hide();
    }
    let _ = app.emit_to("main", "idle-choice", serde_json::json!({ "remove": remove, "stop": stop }));
}

// ---- insights window -------------------------------------------------------
//
// Insights (the stats grid, the uninvoiced breakdown and the two charts) used
// to be an overlay inside the 380x330 popover, where it had to scroll to show
// content that easily fits a normal panel. Like the idle prompt it is its own
// borderless window now, sized to what its content measures and placed beside
// the popover it was opened from — so it is not limited by the timer's frame.

const INSIGHTS_LABEL: &str = "insights";
/// Logical size: the width is fixed, the height is what the webview measures
/// once the (translated, data-dependent) panel has laid out.
const INSIGHTS_WIDTH: f64 = 440.0;
const INSIGHTS_HEIGHT: f64 = 540.0;
/// Never smaller than this, however little the webview reports.
const INSIGHTS_MIN_HEIGHT: f64 = 320.0;
/// Breathing room between the popover and the panel, in logical pixels.
const INSIGHTS_GAP: f64 = 8.0;

/// Whether the panel is meant to be on screen. Set before the window exists,
/// so the watchdog below knows a fast open-then-close should stay closed.
static INSIGHTS_OPEN: AtomicBool = AtomicBool::new(false);

fn insights_wanted() -> bool {
    INSIGHTS_OPEN.load(Ordering::SeqCst)
}

/// Where to put a `size` panel so it sits beside `anchor` and still fits the
/// screen: to its right, flipped to its left when there is no room, top edges
/// aligned, then clamped into the work area. All values are physical pixels.
///
/// Beside, not below: the popover hangs from the menubar, so a panel this tall
/// under it would run off the bottom of every laptop display.
fn beside_position(anchor: ScreenRect, size: (f64, f64), work: ScreenRect, gap: f64) -> (f64, f64) {
    let (width, height) = size;
    let right = anchor.x + anchor.width + gap;
    let left = anchor.x - width - gap;
    let fits_right = right + width <= work.x + work.width;
    let fits_left = left >= work.x;
    let x = if fits_right || !fits_left { right } else { left };
    (
        x.clamp(work.x, (work.x + work.width - width).max(work.x)),
        anchor.y.clamp(work.y, (work.y + work.height - height).max(work.y)),
    )
}

/// The main popover's own rectangle, when it is on screen: what the panel
/// hangs off. Falls back to the menubar icon, as the idle prompt does.
fn insights_anchor(app: &tauri::AppHandle) -> Option<ScreenRect> {
    let main = app.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false));
    let rect = main.and_then(|window| {
        let origin = window.outer_position().ok()?;
        let size = window.outer_size().ok()?;
        Some(ScreenRect { x: origin.x as f64, y: origin.y as f64, width: size.width as f64, height: size.height as f64 })
    });
    rect.or_else(|| tray_anchor(app))
}

/// The height to open the panel at, given what its content measured and how
/// much of the display it can have. The upper bound used to be a flat 720
/// logical pixels, which quietly cut the charts off the bottom of a panel with
/// a long uninvoiced breakdown even on a display with room to spare; a panel
/// that genuinely can't fit the screen is capped here and scrolls instead
/// (see the insights window's `overflow-y` in Insights.vue).
fn insights_height(measured: f64, available: f64) -> f64 {
    measured.clamp(INSIGHTS_MIN_HEIGHT, available.max(INSIGHTS_MIN_HEIGHT))
}

/// How tall the panel may grow on the display it will open on, in logical
/// pixels. Falls back to the fixed height when there is nothing to measure
/// against yet.
fn insights_available_height(app: &tauri::AppHandle) -> f64 {
    let Some(window) = app.get_webview_window(INSIGHTS_LABEL) else {
        return INSIGHTS_HEIGHT;
    };
    let Some(anchor) = insights_anchor(app) else {
        return INSIGHTS_HEIGHT;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let area = work_area(app, anchor.x + anchor.width / 2.0, anchor.y);
    area.height / scale - 2.0 * INSIGHTS_GAP
}

/// Size the panel to its content, put it where it fits, and show it.
fn place_insights(app: &tauri::AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(INSIGHTS_LABEL) else {
        return;
    };
    // A panel already on screen only ever resizes: it must not jump back
    // beside the popover, nor steal focus, when it refreshes its figures. It
    // still has to stay on the display, though — a refresh that adds rows
    // would otherwise push its bottom edge off the screen.
    let showing = window.is_visible().unwrap_or(false);
    let _ = window.set_size(LogicalSize::new(INSIGHTS_WIDTH, height));
    let scale = window.scale_factor().unwrap_or(1.0);
    if showing {
        if let Ok(pos) = window.outer_position() {
            let (x, y) = (pos.x as f64, pos.y as f64);
            let area = work_area(app, x + INSIGHTS_WIDTH * scale / 2.0, y);
            let bottom = area.y + area.height;
            let clamped = y.clamp(area.y, (bottom - height * scale).max(area.y));
            if clamped != y {
                let _ = window.set_position(PhysicalPosition::new(x, clamped));
            }
        }
        return;
    }
    if let Some(anchor) = insights_anchor(app) {
        let area = work_area(app, anchor.x + anchor.width / 2.0, anchor.y);
        let (x, y) = beside_position(anchor, (INSIGHTS_WIDTH * scale, height * scale), area, INSIGHTS_GAP * scale);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to("main", "insights-visible", true);
}

/// Put the panel away and tell the popover, which draws its button as pressed
/// while it is up. Also the path taken when focus leaves the app.
fn hide_insights(app: &tauri::AppHandle) {
    INSIGHTS_OPEN.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(INSIGHTS_LABEL) {
        let _ = window.hide();
    }
    let _ = app.emit_to("main", "insights-visible", false);
}

/// Open the panel, building its window the first time and re-showing it after
/// that. It is created hidden and reveals itself through `fit_insights` once
/// its content is laid out, so it never flashes at the wrong size; the
/// watchdog covers a webview that never gets that far.
fn show_insights(app: &tauri::AppHandle) {
    INSIGHTS_OPEN.store(true, Ordering::SeqCst);
    if app.get_webview_window(INSIGHTS_LABEL).is_some() {
        // reused window: it is already mounted, so tell it to reload and re-fit
        let _ = app.emit_to(INSIGHTS_LABEL, "insights-show", ());
    } else {
        let _ = WebviewWindowBuilder::new(app, INSIGHTS_LABEL, WebviewUrl::App("index.html#insights".into()))
            .title("Zebu")
            .inner_size(INSIGHTS_WIDTH, INSIGHTS_HEIGHT)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            .visible(false)
            .focused(false)
            .build();
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let hidden = app
            .get_webview_window(INSIGHTS_LABEL)
            .and_then(|w| w.is_visible().ok())
            .map(|visible| !visible)
            .unwrap_or(false);
        if hidden && insights_wanted() {
            place_insights(&app, INSIGHTS_HEIGHT);
        }
    });
}

/// The insights button in the popover's header: open the panel, or put it
/// away again. Returns whether it is now on screen, for the button's state.
#[tauri::command]
fn toggle_insights(app: tauri::AppHandle) -> bool {
    // what was asked for, not what is on screen: a second click while the
    // panel is still measuring itself has to close it, not open it twice
    if insights_wanted() {
        hide_insights(&app);
        false
    } else {
        show_insights(&app);
        true
    }
}

/// Close the panel — its own close button, Escape, or signing out.
#[tauri::command]
fn close_insights(app: tauri::AppHandle) {
    hide_insights(&app);
}

/// The panel reporting the height its content needs; also what reveals it.
#[tauri::command]
fn fit_insights(app: tauri::AppHandle, height: f64) {
    if !insights_wanted() {
        return; // closed again while it was still measuring
    }
    let available = insights_available_height(&app);
    place_insights(&app, insights_height(height, available));
}

/// Quit the app entirely — a menubar app with no dock icon otherwise has no
/// obvious way out.
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Whether the popover hides itself when focus moves to another app.
#[tauri::command]
fn set_hide_on_blur(hide: bool) {
    HIDE_ON_BLUR.store(hide, Ordering::SeqCst);
}

/// "Hide when changing focus", for the popover and the insights panel
/// together: they are two windows of one popover, so clicking from one to the
/// other must not dismiss either. Which of them ends up with focus is only
/// settled after the blur event — the window being clicked has not been
/// focused yet — so the answer is read a moment later, and only a focus that
/// left the app at all puts both away.
fn hide_popovers_when_focus_left(app: tauri::AppHandle) {
    if !HIDE_ON_BLUR.load(Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        if idle_prompt_pending() {
            return; // an unanswered question keeps the list up behind it
        }
        let ours_focused = ["main", INSIGHTS_LABEL]
            .iter()
            .any(|label| app.get_webview_window(label).and_then(|w| w.is_focused().ok()).unwrap_or(false));
        if ours_focused {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        hide_insights(&app);
    });
}

/// Show or hide the app in the dock and app switcher (macOS).
#[tauri::command]
fn set_dock_visible(app: tauri::AppHandle, visible: bool) {
    DOCK_MODE.store(visible, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

fn apply_icon(tray: &TrayIcon, rendered: Option<(tauri::image::Image<'static>, bool)>) {
    if let Some((icon, template)) = rendered {
        // set_icon builds a fresh NSImage each time, dropping the template
        // flag — it must be re-applied with every frame or the idle pill
        // renders raw black on a dark menubar
        let _ = tray.set_icon(Some(icon));
        let _ = tray.set_icon_as_template(template);
    }
}

/// Update the menubar widget: a rendered pill showing play + "zzzz" when
/// idle, or green pause bars + the elapsed time while a timer runs. `detail`
/// (project · task) feeds the hover tooltip as a quick preview. `tooltip`
/// carries the fully formatted, localized tooltip from the frontend (which
/// owns the locale catalogs); the format! fallback below only covers older
/// callers that don't send one.
#[tauri::command]
fn set_tray_title(app: tauri::AppHandle, title: String, detail: Option<String>, running: bool, tooltip: Option<String>) {
    // Kept outside the tray lookup below: the click handler reads this even on
    // platforms (or in the moments) where there is no tray to draw on.
    TIMER_RUNNING.store(running, Ordering::SeqCst);
    if let Some(tray) = app.tray_by_id("main") {
        let elapsed = (!title.is_empty()).then_some(title.as_str());

        #[cfg(not(target_os = "linux"))]
        apply_icon(&tray, tray_icon::render(elapsed, running));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(None::<String>);

        let tip = tooltip.filter(|t| !t.is_empty()).unwrap_or_else(|| {
            match (elapsed, detail.filter(|d| !d.is_empty())) {
                (Some(t), Some(d)) if running => format!("{d} · {t}"),
                (Some(t), Some(d)) => format!("{d} · {t} (stopped)"),
                (Some(t), None) => format!("Zebu — {t}"),
                _ => "Zebu".to_string(),
            }
        });
        #[cfg(target_os = "linux")]
        if let Some(item) = TRAY_STATUS_ITEM.get() {
            let _ = item.set_text(&tip);
        }
        let _ = tray.set_tooltip(Some(tip));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init());

    // Auto-update is a desktop concern: the updater fetches latest.json from
    // the GitHub release (endpoint + public key in tauri.conf.json) and the
    // process plugin relaunches into the freshly installed build.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .invoke_handler(tauri::generate_handler![
            set_tray_title,
            quit,
            idle_seconds,
            set_idle_threshold,
            set_dock_visible,
            set_hide_on_blur,
            show_idle_prompt,
            idle_prompt_data,
            fit_idle_prompt,
            resolve_idle_prompt,
            toggle_insights,
            close_insights,
            fit_insights
        ])
        .on_window_event(|window, event| {
            // "Hide when changing focus": the popover hides itself when focus
            // moves elsewhere, unless the preference turns that off.
            if let WindowEvent::Focused(false) = event {
                // An unanswered idle prompt is a question, not a popover: it
                // stays up (it loses focus the moment the list is clicked),
                // and the list stays visible behind it for context.
                if window.label() == IDLE_LABEL || idle_prompt_pending() {
                    return;
                }
                let label = window.label();
                if label == "main" || label == INSIGHTS_LABEL {
                    hide_popovers_when_focus_left(window.app_handle().clone());
                }
            }
        })
        .setup(|app| {
            // No dock icon on macOS — this is a menubar-only app by default;
            // the "Show in Dock" preference flips it at runtime.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[allow(unused_mut)] // only reassigned on Linux, see below
            let mut tray_builder = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Zebu")
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);

                    match event {
                        // The pill draws a play or a pause glyph, so pressing it
                        // presses play/pause — it no longer just opens the
                        // popover. Rust can't act on a timer itself (auth and
                        // HTTP live in the frontend's api.ts), so the main window
                        // is told what was pressed and owns what it means, the
                        // same round-trip the idle prompt's answers take through
                        // `idle-choice`.
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if TIMER_RUNNING.load(Ordering::SeqCst) {
                                // Pause: stop the timer where it stands, showing
                                // and hiding nothing. Pressing pause should feel
                                // like a button, not like launching an app.
                                let _ = app.emit_to("main", "tray-toggle-timer", ());
                            } else {
                                // Play: there is nothing to pause, so offer to
                                // start something. Show the popover first so the
                                // form opens into a window that is already placed;
                                // the main webview runs whether or not the window
                                // is visible, so the event needs no delay to be
                                // heard (unlike the idle prompt, whose window is
                                // built on demand and reveals itself once its text
                                // is laid out).
                                show_popover(app);
                                let _ = app.emit_to("main", "tray-open-new-timer", ());
                            }
                        }
                        // Design decision (board card #34 left it open): left-click
                        // now acts on the timer, which would otherwise cost you the
                        // only way to reach the week, insights and settings while a
                        // timer runs — you'd have to stop it to look at anything.
                        // Secondary click inherits the plain open/close toggle, so
                        // nothing that worked before is gone; it moved to the other
                        // button. Reconsider if the toggle turns out to be worth
                        // more than the one-press pause.
                        TrayIconEvent::Click {
                            button: MouseButton::Right,
                            button_state: MouseButtonState::Up,
                            ..
                        } => toggle_popover(tray.app_handle()),
                        _ => {}
                    }
                });

            // Linux never emits the click event above at all (Tauri: "Unsupported.
            // The event is not emitted even though the icon is shown") — clicking
            // did nothing, which is the bug this fixes. A menu is the only
            // interaction the AppIndicator protocol offers there, so it also
            // carries the live status line the (also unsupported) tooltip can't.
            #[cfg(target_os = "linux")]
            {
                let status = MenuItem::with_id(app, "status", "Zebu", false, None::<&str>)?;
                let open = MenuItem::with_id(app, "open", "Open Zebu", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit Zebu", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&status, &open, &quit])?;
                let _ = TRAY_STATUS_ITEM.set(status);
                tray_builder = tray_builder.menu(&menu).on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_popover(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            }

            let tray = tray_builder.build(app)?;

            // start on the idle pill (Linux keeps the plain app icon set above —
            // our custom pill can't render as a normal square tray icon there)
            #[cfg(not(target_os = "linux"))]
            apply_icon(&tray, tray_icon::render(None, false));
            #[cfg(target_os = "linux")]
            let _ = &tray;

            spawn_idle_watcher(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod idle_tests {
    use super::away_seconds;

    #[test]
    fn a_climbing_counter_is_not_a_return() {
        assert_eq!(away_seconds(600, 2, 602), None);
        assert_eq!(away_seconds(600, 2, 601), None); // jitter
        assert_eq!(away_seconds(0, 2, 2), None);
    }

    #[test]
    fn input_after_a_long_stretch_reports_the_whole_absence() {
        // idle 15 minutes, sampled 2 s later with the counter reset by a keypress
        assert_eq!(away_seconds(900, 2, 1), Some(901));
    }

    #[test]
    fn a_wall_clock_gap_counts_as_absence() {
        // the laptop slept for two hours; macOS's counter did not tick meanwhile
        assert_eq!(away_seconds(300, 7200, 302), Some(7198));
        // …and the user pressed a key on waking
        assert_eq!(away_seconds(300, 7200, 0), Some(7500));
    }

    #[test]
    fn a_short_fidget_is_ignored_by_the_caller_threshold() {
        assert_eq!(away_seconds(40, 2, 0), Some(42)); // below any sane threshold
    }
}

#[cfg(test)]
mod prompt_position_tests {
    use super::{prompt_position, ScreenRect};

    /// A 1440x900 display with a 25px menubar, as physical pixels.
    const WORK: ScreenRect = ScreenRect { x: 0.0, y: 25.0, width: 1440.0, height: 875.0 };
    const SIZE: (f64, f64) = (330.0, 220.0);

    fn anchor(x: f64, y: f64) -> ScreenRect {
        ScreenRect { x, y, width: 24.0, height: 24.0 }
    }

    #[test]
    fn hangs_centred_under_the_anchor_when_there_is_room() {
        // stop button at the top of the list, plenty of screen below it
        assert_eq!(prompt_position(anchor(700.0, 200.0), SIZE, WORK, 6.0), (547.0, 230.0));
    }

    #[test]
    fn flips_above_the_anchor_rather_than_off_the_bottom() {
        // the running entry sits near the bottom of a long list: below would
        // run past the screen edge, so the prompt goes above the button
        assert_eq!(prompt_position(anchor(700.0, 800.0), SIZE, WORK, 6.0), (547.0, 574.0));
    }

    #[test]
    fn stays_on_screen_at_the_left_and_right_edges() {
        assert_eq!(prompt_position(anchor(4.0, 200.0), SIZE, WORK, 6.0).0, 0.0);
        assert_eq!(prompt_position(anchor(1420.0, 200.0), SIZE, WORK, 6.0).0, 1110.0);
    }

    #[test]
    fn a_screen_too_short_for_either_side_still_shows_the_whole_prompt() {
        let cramped = ScreenRect { x: 0.0, y: 0.0, width: 800.0, height: 300.0 };
        let (_, y) = prompt_position(anchor(400.0, 150.0), SIZE, cramped, 6.0);
        assert_eq!(y, 80.0); // clamped so the bottom edge lands on the work area's
    }

    #[test]
    fn a_second_display_is_placed_in_its_own_coordinates() {
        let right = ScreenRect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(prompt_position(anchor(1450.0, 100.0), SIZE, right, 6.0), (1440.0, 130.0));
    }
}

#[cfg(test)]
mod insights_height_tests {
    use super::{insights_height, INSIGHTS_MIN_HEIGHT};

    /// A 900px-tall display's work area, in logical pixels.
    const AVAILABLE: f64 = 875.0;

    #[test]
    fn takes_the_height_the_content_measured() {
        assert_eq!(insights_height(545.0, AVAILABLE), 545.0);
    }

    #[test]
    fn a_long_breakdown_grows_past_the_old_fixed_ceiling() {
        // twelve currency rows measured 745: the flat 720 cap used to slice
        // the second chart's caption off with no way to scroll to it
        assert_eq!(insights_height(745.0, AVAILABLE), 745.0);
        assert_eq!(insights_height(870.0, AVAILABLE), 870.0);
    }

    #[test]
    fn never_grows_past_what_the_display_can_show() {
        assert_eq!(insights_height(1200.0, AVAILABLE), AVAILABLE);
    }

    #[test]
    fn a_panel_still_measuring_itself_gets_a_usable_minimum() {
        assert_eq!(insights_height(0.0, AVAILABLE), INSIGHTS_MIN_HEIGHT);
    }

    #[test]
    fn a_display_shorter_than_the_minimum_still_shows_the_minimum() {
        // the whole panel scrolls there rather than opening as a sliver
        assert_eq!(insights_height(600.0, 200.0), INSIGHTS_MIN_HEIGHT);
    }
}

#[cfg(test)]
mod beside_position_tests {
    use super::{beside_position, ScreenRect};

    /// A 1440x900 display with a 25px menubar, as physical pixels.
    const WORK: ScreenRect = ScreenRect { x: 0.0, y: 25.0, width: 1440.0, height: 875.0 };
    /// The insights panel, at roughly the height its content measures.
    const SIZE: (f64, f64) = (440.0, 540.0);

    /// The popover, hanging from a menubar icon at `x`.
    fn popover(x: f64) -> ScreenRect {
        ScreenRect { x, y: 25.0, width: 380.0, height: 330.0 }
    }

    #[test]
    fn sits_to_the_right_of_the_popover_with_its_top_aligned() {
        assert_eq!(beside_position(popover(300.0), SIZE, WORK, 8.0), (688.0, 25.0));
    }

    #[test]
    fn flips_to_the_left_when_the_right_edge_is_out_of_room() {
        // menubar icon near the right corner: the popover is already there,
        // so the panel goes on its other side rather than off the screen
        assert_eq!(beside_position(popover(1050.0), SIZE, WORK, 8.0), (602.0, 25.0));
    }

    #[test]
    fn a_display_too_narrow_for_either_side_still_shows_the_whole_panel() {
        let narrow = ScreenRect { x: 0.0, y: 0.0, width: 800.0, height: 900.0 };
        assert_eq!(beside_position(popover(300.0), SIZE, narrow, 8.0).0, 360.0);
    }

    #[test]
    fn a_panel_taller_than_the_space_below_is_pulled_up_onto_the_screen() {
        // anchored low (the tray at the bottom of a Windows taskbar, say)
        let (_, y) = beside_position(ScreenRect { x: 400.0, y: 700.0, width: 24.0, height: 24.0 }, SIZE, WORK, 8.0);
        assert_eq!(y, 360.0); // bottom edge lands on the work area's
    }

    #[test]
    fn a_second_display_is_placed_in_its_own_coordinates() {
        let right = ScreenRect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(beside_position(popover(1450.0), SIZE, right, 8.0), (1838.0, 25.0));
    }
}
