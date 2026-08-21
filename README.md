# Freilancer Desktop

A tiny cross-platform **menubar/tray app** for [Freilancer](../freelancer): see today's timers at a glance, start/stop/resume them, add entries, and check your time summary — built with **Tauri 2** (Rust) + Vue 3, so the binary is a few megabytes and idles at ~0% CPU.

## Features

- Menubar popover (no dock icon on macOS); click the tray icon to toggle
- Week strip with per-day totals, ‹ › week navigation, **Jump to Today**
- Day view listing entries with resume ▶ / stop ■ / delete; running entry ticks live
- Running timer shown **next to the menubar icon** (macOS) / tray tooltip elsewhere
- **New Time Entry** sheet: project + task + notes; leave duration empty to start a live timer, or enter `1:30` to log it directly
- ⓘ **Time Summary** popover: hours today / yesterday / this week / last week / this month + billable % (served by your own server's widgets)
- Respects invoiced-entry locks and approved-week locks from the server

## Authentication

No passwords in the app. On first launch you enter your server URL; the app opens your **browser** to a one-time approval page on your Freilancer site (you must be logged in there), you click **Approve**, and the app receives a personal access token. Revoke it anytime by deleting the token in the database or "Disconnect this device" in the app's settings.

## Development

Prerequisites: Rust (rustup), Node 20+, and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev
```

The dev server expects your Freilancer instance to be reachable (e.g. `http://127.0.0.1:8000` via `composer dev` in the server repo).

## Building & distribution

```bash
# one-time: generate the full icon set from the source PNG
npm run tauri icon src-tauri/icons/icon.png

npm run tauri build
```

This produces native installers per platform (`.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.rpm`/AppImage on Linux) under `src-tauri/target/release/bundle/`. For signed/notarized macOS builds and auto-updates, see Tauri's distribution docs; a GitHub Actions matrix with `tauri-apps/tauri-action` is the usual way to release all three platforms from one tag.

## Server requirements

The companion API ships with the Freilancer server (`routes/api.php`): device-flow endpoints (`/api/device/*`), and Sanctum-authenticated `/api/timesheet`, `/api/timer/*`, `/api/time`, `/api/summary`.
