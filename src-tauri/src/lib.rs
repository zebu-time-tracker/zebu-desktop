mod tray_icon;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
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
                                    let _ = window.move_window(Position::TrayCenter);
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // start on the idle pill
            apply_icon(&tray, tray_icon::render(None, false));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
