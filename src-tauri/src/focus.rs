// ---- focus tracking --------------------------------------------------------
//
// Board card #401: a quiet record of which app (and, with permission, which
// window) was in front, so the Focus tab in Insights can show where the day
// went and suggest entries to log. It is strictly opt-in and strictly local:
//
// - nothing is sampled until the user turns it on in Settings;
// - spans go to a JSON-lines file in the app's data directory and nowhere
//   else — no command here talks to the network, and the frontend never
//   sends them to the server;
// - anything older than RETENTION_MS is pruned at launch and hourly;
// - "Delete focus history" removes the file and the span in progress;
// - apps on the exclude list are never recorded, not even their name, and
//   titles of private/incognito browser windows are dropped.
//
// The watcher is a native thread for the same reason the idle watcher is:
// webview timers stall while the popover is hidden. Every rule worth testing
// (coalescing, the minimum length, pruning, exclusion, private titles) is a
// plain function over plain data below the thread, so none of it needs a Mac.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager};

/// How often the frontmost window is sampled.
const SAMPLE_S: u64 = 5;
/// Spans shorter than this are glances, not focus, and are dropped.
pub const MIN_SPAN_MS: u64 = 20_000;
/// Two samples further apart than this belong to different spans: the Mac
/// slept, or the thread was suspended, in between.
const MAX_GAP_MS: u64 = 3 * SAMPLE_S * 1000;
/// After this long without keyboard or mouse input, nothing is recorded: the
/// window in front is not what anyone is looking at.
const IDLE_AFTER_S: u64 = 120;
/// History is kept this long, then deleted.
pub const RETENTION_MS: u64 = 14 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS: u64 = 60 * 60 * 1000;
const FILE_NAME: &str = "focus.jsonl";

/// One stretch of time with the same app and window in front. Times are unix ms.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Span {
    pub app: String,
    pub title: String,
    pub start: u64,
    pub end: u64,
}

impl Span {
    fn duration_ms(&self) -> u64 {
        self.end.saturating_sub(self.start)
    }
}

/// What was in front at one sample: the app's name and, when the OS let us
/// read it, the focused window's title.
#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub app: String,
    pub title: Option<String>,
}

/// Turns a stream of samples into spans. `observe` is fed every tick — `None`
/// when there is nothing to record (idle, excluded, tracking off) — and hands
/// back a span each time one closes and is long enough to keep.
#[derive(Default)]
pub struct Coalescer {
    current: Option<Span>,
}

impl Coalescer {
    pub fn observe(&mut self, sample: Option<&Sample>, now: u64) -> Option<Span> {
        let Some(sample) = sample else {
            return self.close();
        };
        let title = sample.title.clone().unwrap_or_default();
        if let Some(cur) = self.current.as_mut() {
            let contiguous = now >= cur.end && now - cur.end <= MAX_GAP_MS;
            if contiguous && cur.app == sample.app && cur.title == title {
                cur.end = now;
                return None;
            }
            if contiguous {
                // the switch happened somewhere since the last sample; the new
                // span picks up where the old one stopped so the day has no holes
                let start = cur.end;
                let done = self.current.replace(Span { app: sample.app.clone(), title, start, end: now });
                return done.filter(|s| s.duration_ms() >= MIN_SPAN_MS);
            }
        }
        let done = self.current.replace(Span { app: sample.app.clone(), title, start: now, end: now });
        done.filter(|s| s.duration_ms() >= MIN_SPAN_MS)
    }

    /// End the span in progress, keeping it if it is long enough.
    pub fn close(&mut self) -> Option<Span> {
        self.current.take().filter(|s| s.duration_ms() >= MIN_SPAN_MS)
    }

    /// The span in progress, for a live view of today. Not yet filtered.
    pub fn current(&self) -> Option<&Span> {
        self.current.as_ref()
    }

    /// Forget the span in progress without keeping it.
    pub fn discard(&mut self) {
        self.current = None;
    }
}

/// Whether `app` is on the exclude list. Names are compared whole, ignoring
/// case and surrounding space, so "1password" excludes "1Password" but not
/// "1Password Helper Notes".
pub fn is_excluded(app: &str, exclude: &[String]) -> bool {
    let app = app.trim();
    exclude.iter().any(|e| !e.trim().is_empty() && e.trim().eq_ignore_ascii_case(app))
}

/// Whether a window title belongs to a private or incognito browser window.
/// Only what the browser puts in the title can be seen: Firefox ("Private
/// Browsing"), Edge ("InPrivate"), Chrome/Brave/Arc when they add
/// "Incognito"/"Private". Safari says nothing in its titles, so its private
/// windows cannot be told apart — see the PR for that caveat.
pub fn is_private_title(title: &str) -> bool {
    let t = title.to_lowercase();
    ["private browsing", "inprivate", "incognito", "private window"]
        .iter()
        .any(|m| t.contains(m))
}

/// The sample as it may be recorded, or None when it must not be recorded
/// at all: excluded apps vanish entirely, private windows lose their title.
pub fn sanitise(sample: Sample, exclude: &[String]) -> Option<Sample> {
    if sample.app.trim().is_empty() || is_excluded(&sample.app, exclude) {
        return None;
    }
    let title = sample
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && !is_private_title(t));
    Some(Sample { app: sample.app, title })
}

/// Spans from a JSON-lines body that end on or after `cutoff`, in file
/// order. Lines that do not parse are dropped, so a torn write costs one span.
pub fn parse_lines(body: &str, cutoff: u64) -> Vec<Span> {
    body.lines()
        .filter_map(|l| serde_json::from_str::<Span>(l).ok())
        .filter(|s| s.end >= cutoff)
        .collect()
}

/// The oldest end time kept at `now`.
pub fn retention_cutoff(now: u64) -> u64 {
    now.saturating_sub(RETENTION_MS)
}

// ---- storage ---------------------------------------------------------------

struct Store {
    path: PathBuf,
}

impl Store {
    fn append(&self, span: &Span) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            if let Ok(line) = serde_json::to_string(span) {
                let _ = writeln!(f, "{line}");
            }
        }
    }

    fn read(&self, cutoff: u64) -> Vec<Span> {
        fs::read_to_string(&self.path).map(|b| parse_lines(&b, cutoff)).unwrap_or_default()
    }

    /// Rewrite the file without anything past retention.
    fn prune(&self, now: u64) {
        let Ok(body) = fs::read_to_string(&self.path) else {
            return;
        };
        let kept = parse_lines(&body, retention_cutoff(now));
        let mut out = String::new();
        for s in &kept {
            if let Ok(line) = serde_json::to_string(s) {
                out.push_str(&line);
                out.push('\n');
            }
        }
        if out.len() != body.len() {
            let tmp = self.path.with_extension("jsonl.tmp");
            if fs::write(&tmp, out).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }

    fn clear(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

// ---- the watcher -----------------------------------------------------------

static ENABLED: AtomicBool = AtomicBool::new(false);
static EXCLUDE: Mutex<Vec<String>> = Mutex::new(Vec::new());
static COALESCER: Mutex<Option<Coalescer>> = Mutex::new(None);
static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn now_ms() -> u64 {
    crate::unix_ms(SystemTime::now())
}

fn with_store(f: impl FnOnce(&Store)) {
    if let Ok(store) = STORE.lock() {
        if let Some(store) = store.as_ref() {
            f(store);
        }
    }
}

/// Feed one tick into the coalescer and store whatever it closes.
fn record(sample: Option<&Sample>, now: u64) {
    let done = COALESCER
        .lock()
        .ok()
        .and_then(|mut c| c.get_or_insert_with(Coalescer::default).observe(sample, now));
    if let Some(span) = done {
        with_store(|s| s.append(&span));
    }
}

pub fn spawn_focus_watcher(app: tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let store = Store { path: dir.join(FILE_NAME) };
        store.prune(now_ms());
        if let Ok(mut s) = STORE.lock() {
            *s = Some(store);
        }
    }
    std::thread::spawn(move || {
        let mut last_prune = now_ms();
        loop {
            std::thread::sleep(Duration::from_secs(SAMPLE_S));
            let now = now_ms();
            if now.saturating_sub(last_prune) >= PRUNE_EVERY_MS {
                last_prune = now;
                with_store(|s| s.prune(now));
            }
            if !ENABLED.load(Ordering::SeqCst) || crate::idle_seconds() >= IDLE_AFTER_S {
                record(None, now);
                continue;
            }
            let exclude = EXCLUDE.lock().map(|e| e.clone()).unwrap_or_default();
            let sample = platform::frontmost().and_then(|s| sanitise(s, &exclude));
            record(sample.as_ref(), now);
        }
    });
    let _ = app; // the handle is only needed for the data directory
}

// ---- commands --------------------------------------------------------------

/// The frontend's preference: on or off, and the apps never to record.
/// Turning it off closes (and keeps) the span in progress.
#[tauri::command]
pub fn set_focus_tracking(enabled: bool, exclude: Vec<String>) {
    if let Ok(mut e) = EXCLUDE.lock() {
        *e = exclude;
    }
    let was = ENABLED.swap(enabled, Ordering::SeqCst);
    if was && !enabled {
        record(None, now_ms());
    }
}

/// Recorded spans overlapping `[from, to]` (unix ms), plus the one in
/// progress when it is already long enough to count.
#[tauri::command]
pub fn focus_spans(from: u64, to: u64) -> Vec<Span> {
    let mut spans = Vec::new();
    with_store(|s| spans = s.read(retention_cutoff(now_ms()).max(from)));
    if let Ok(c) = COALESCER.lock() {
        if let Some(cur) = c.as_ref().and_then(|c| c.current()) {
            if cur.duration_ms() >= MIN_SPAN_MS {
                spans.push(cur.clone());
            }
        }
    }
    spans.retain(|s| s.end >= from && s.start <= to);
    spans
}

/// Whether window titles can be read, and so whether the Focus tab should
/// ask for permission. Always true where no permission is involved.
#[tauri::command]
pub fn focus_titles_allowed() -> bool {
    platform::titles_allowed()
}

/// Ask the OS for the permission titles need (macOS: Accessibility) and open
/// the pane where it is granted.
#[tauri::command]
pub fn focus_request_titles(app: tauri::AppHandle) {
    platform::request_titles(&app);
}

/// "Delete focus history": the file and the span in progress.
#[tauri::command]
pub fn focus_clear() {
    if let Ok(mut c) = COALESCER.lock() {
        if let Some(c) = c.as_mut() {
            c.discard();
        }
    }
    with_store(|s| s.clear());
}

/// A suggestion clicked in the Focus tab: bring the popover up and hand the
/// prefill to the main window, which owns the new-entry sheet. Nothing is
/// created here or there until the user presses Log.
#[tauri::command]
pub fn open_focus_suggestion(app: tauri::AppHandle, draft: serde_json::Value) {
    crate::show_popover(&app);
    let _ = app.emit_to("main", "focus-log", draft);
}

// ---- platform --------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    //! macOS: the frontmost app from NSWorkspace (no permission needed), the
    //! focused window's title from the Accessibility API.
    //!
    //! Accessibility over Screen Recording: CGWindowListCopyWindowInfo only
    //! returns window names with Screen Recording, whose prompt reads "record
    //! this computer's screen" and which macOS 15 re-confirms monthly. The
    //! Accessibility prompt is the one every window manager and timer app
    //! asks for, and it reads the *focused* window rather than guessing it
    //! from the z-order.

    use super::Sample;
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use objc2_app_kit::NSWorkspace;

    type AXUIElementRef = CFTypeRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    pub fn titles_allowed() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn request_titles(app: &tauri::AppHandle) {
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        let trusted = unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) };
        if !trusted {
            use tauri_plugin_opener::OpenerExt;
            let _ = app
                .opener()
                .open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", None::<&str>);
        }
    }

    /// The focused window's title of process `pid`, or None without
    /// permission, without a window, or when the app does not answer in time.
    fn window_title(pid: i32) -> Option<String> {
        if !titles_allowed() {
            return None;
        }
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return None;
            }
            // a hung app must not stall the watcher
            AXUIElementSetMessagingTimeout(app, 0.5);
            let mut window: CFTypeRef = std::ptr::null();
            let focused = CFString::from_static_string("AXFocusedWindow");
            let ok = AXUIElementCopyAttributeValue(app, focused.as_concrete_TypeRef(), &mut window) == 0 && !window.is_null();
            CFRelease(app);
            if !ok {
                return None;
            }
            let mut title: CFTypeRef = std::ptr::null();
            let attr = CFString::from_static_string("AXTitle");
            let ok = AXUIElementCopyAttributeValue(window, attr.as_concrete_TypeRef(), &mut title) == 0 && !title.is_null();
            CFRelease(window);
            if !ok {
                return None;
            }
            let cf = core_foundation::base::CFType::wrap_under_create_rule(title);
            cf.downcast::<CFString>().map(|s| s.to_string())
        }
    }

    pub fn frontmost() -> Option<Sample> {
        #[allow(unused_unsafe)]
        let running = unsafe { NSWorkspace::sharedWorkspace().frontmostApplication() }?;
        #[allow(unused_unsafe)]
        let (name, pid) = unsafe { (running.localizedName()?.to_string(), running.processIdentifier()) };
        Some(Sample { title: window_title(pid), app: name })
    }
}

#[cfg(target_os = "windows")]
mod platform {
    //! Windows: the foreground window and its owning executable. Titles need
    //! no permission there.

    use super::Sample;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

    pub fn titles_allowed() -> bool {
        true
    }

    pub fn request_titles(_app: &tauri::AppHandle) {}

    pub fn frontmost() -> Option<Sample> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
            let title = String::from_utf16_lossy(&buf[..len]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut path = [0u16; 1024];
            let mut size = path.len() as u32;
            let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut size).is_ok();
            let _ = CloseHandle(process);
            if !named {
                return None;
            }
            let path = String::from_utf16_lossy(&path[..size as usize]);
            let app = std::path::Path::new(&path).file_stem()?.to_string_lossy().to_string();
            Some(Sample { app, title: Some(title) })
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    //! Linux and the rest: not yet. X11 and every Wayland compositor answer
    //! "which window is in front?" differently; the Focus tab says so.

    use super::Sample;

    pub fn titles_allowed() -> bool {
        false
    }

    pub fn request_titles(_app: &tauri::AppHandle) {}

    pub fn frontmost() -> Option<Sample> {
        None
    }
}

/// Whether this platform can sample at all, for the settings row.
#[tauri::command]
pub fn focus_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000_000;

    fn sample(app: &str, title: &str) -> Sample {
        Sample { app: app.into(), title: Some(title.into()) }
    }

    /// Feed `ticks` samples of one window, 5 s apart from `start`.
    fn feed(c: &mut Coalescer, s: &Sample, start: u64, ticks: u64) -> Vec<Span> {
        (0..ticks).filter_map(|i| c.observe(Some(s), start + i * 5_000)).collect()
    }

    #[test]
    fn consecutive_identical_samples_become_one_span() {
        let mut c = Coalescer::default();
        let code = sample("Code", "lib.rs — zebu-desktop");
        assert!(feed(&mut c, &code, T0, 13).is_empty()); // 0..60 s
        let span = c.close().expect("a minute is long enough");
        assert_eq!(span, Span { app: "Code".into(), title: "lib.rs — zebu-desktop".into(), start: T0, end: T0 + 60_000 });
    }

    #[test]
    fn a_new_window_closes_the_span_and_starts_where_it_ended() {
        let mut c = Coalescer::default();
        feed(&mut c, &sample("Code", "a"), T0, 7); // 0..30 s
        let done = c.observe(Some(&sample("Safari", "GitHub")), T0 + 35_000).expect("30 s span kept");
        assert_eq!((done.start, done.end), (T0, T0 + 30_000));
        assert_eq!(c.current().map(|s| (s.start, s.end)), Some((T0 + 30_000, T0 + 35_000)));
    }

    #[test]
    fn a_title_change_in_the_same_app_is_a_new_span() {
        let mut c = Coalescer::default();
        feed(&mut c, &sample("Safari", "Inbox"), T0, 6);
        assert!(c.observe(Some(&sample("Safari", "Calendar")), T0 + 30_000).is_some());
    }

    #[test]
    fn spans_under_twenty_seconds_are_dropped() {
        let mut c = Coalescer::default();
        feed(&mut c, &sample("Slack", "general"), T0, 4); // 0..15 s
        assert_eq!(c.observe(Some(&sample("Code", "x")), T0 + 20_000), None, "15 s is a glance");
        // exactly the minimum is kept
        let mut c = Coalescer::default();
        feed(&mut c, &sample("Slack", "general"), T0, 5); // 0..20 s
        assert!(c.close().is_some());
    }

    #[test]
    fn idle_or_nothing_to_record_ends_the_span() {
        let mut c = Coalescer::default();
        feed(&mut c, &sample("Code", "a"), T0, 10);
        assert!(c.observe(None, T0 + 50_000).is_some());
        assert!(c.current().is_none());
        assert_eq!(c.observe(None, T0 + 55_000), None);
    }

    #[test]
    fn a_long_gap_such_as_sleep_splits_the_same_window() {
        let mut c = Coalescer::default();
        let s = sample("Code", "a");
        feed(&mut c, &s, T0, 10); // 0..45 s
        let done = c.observe(Some(&s), T0 + 45_000 + 10 * 60_000).expect("the stretch before the lid closed");
        assert_eq!(done.end, T0 + 45_000);
        assert_eq!(c.current().map(|s| s.start), Some(T0 + 45_000 + 10 * 60_000));
    }

    #[test]
    fn excluded_apps_are_matched_whole_and_ignoring_case() {
        let list = vec!["1Password".to_string(), " Keychain Access ".to_string(), "".to_string()];
        assert!(is_excluded("1password", &list));
        assert!(is_excluded("Keychain Access", &list));
        assert!(!is_excluded("1Password Notes", &list));
        assert!(!is_excluded("Safari", &list));
        assert!(!is_excluded("", &[]));
    }

    #[test]
    fn sanitise_drops_excluded_apps_and_private_titles() {
        let list = vec!["1Password".to_string()];
        assert_eq!(sanitise(sample("1Password", "Vault"), &list), None);
        assert_eq!(
            sanitise(sample("Firefox", "Bank — Mozilla Firefox Private Browsing"), &list),
            Some(Sample { app: "Firefox".into(), title: None })
        );
        assert_eq!(sanitise(sample("Microsoft Edge", "News - InPrivate"), &list).unwrap().title, None);
        assert_eq!(sanitise(sample("Google Chrome", "Docs (Incognito)"), &list).unwrap().title, None);
        assert_eq!(sanitise(sample("Code", "  lib.rs  "), &list).unwrap().title.as_deref(), Some("lib.rs"));
        assert_eq!(sanitise(Sample { app: "Finder".into(), title: None }, &list).unwrap().title, None);
    }

    #[test]
    fn retention_keeps_fourteen_days_and_skips_torn_lines() {
        let now = T0;
        let old = Span { app: "A".into(), title: "".into(), start: now - RETENTION_MS - 60_000, end: now - RETENTION_MS - 1 };
        let edge = Span { app: "B".into(), title: "".into(), start: now - RETENTION_MS - 60_000, end: now - RETENTION_MS };
        let fresh = Span { app: "C".into(), title: "t".into(), start: now - 60_000, end: now };
        let body = [&old, &edge, &fresh].iter().map(|s| serde_json::to_string(s).unwrap()).collect::<Vec<_>>().join("\n")
            + "\n{\"app\":\"torn";
        let kept = parse_lines(&body, retention_cutoff(now));
        assert_eq!(kept, vec![edge, fresh]);
    }

    #[test]
    fn prune_rewrites_the_file_without_old_spans() {
        let dir = std::env::temp_dir().join(format!("zebu-focus-test-{}", std::process::id()));
        let store = Store { path: dir.join(FILE_NAME) };
        store.clear();
        let now = T0;
        store.append(&Span { app: "Old".into(), title: "".into(), start: 0, end: 1 });
        store.append(&Span { app: "New".into(), title: "".into(), start: now - 30_000, end: now });
        store.prune(now);
        let left = store.read(0);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].app, "New");
        store.clear();
        assert!(store.read(0).is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
