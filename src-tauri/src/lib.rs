mod tray_icon;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

/// Whether the app currently shows in the dock / app switcher.
static DOCK_MODE: AtomicBool = AtomicBool::new(false);
/// "Hide when changing focus" preference (default on).
static HIDE_ON_BLUR: AtomicBool = AtomicBool::new(true);

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
                        let _ = app.emit("idle-return", serde_json::json!({ "started_at_ms": started_ms, "seconds": away }));
                        show_popover(&app);
                    }
                }
            }
            prev_idle = idle;
            prev_at = now;
        }
    });
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
    if let Some(tray) = app.tray_by_id("main") {
        let elapsed = (!title.is_empty()).then_some(title.as_str());

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
            set_hide_on_blur
        ])
        .on_window_event(|window, event| {
            // "Hide when changing focus": the popover hides itself when focus
            // moves elsewhere, unless the preference turns that off.
            if let WindowEvent::Focused(false) = event {
                if HIDE_ON_BLUR.load(Ordering::SeqCst) {
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // No dock icon on macOS — this is a menubar-only app by default;
            // the "Show in Dock" preference flips it at runtime.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Zebu")
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);

                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    show_popover(app);
                                }
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // start on the idle pill
            apply_icon(&tray, tray_icon::render(None, false));

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
