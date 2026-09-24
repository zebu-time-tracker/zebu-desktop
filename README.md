# Zebu Desktop

A tiny cross-platform **menubar/tray app** for [Zebu](../zebu): see today's timers at a glance, start/stop/resume them, add entries, and check your time summary — built with **Tauri 2** (Rust) + Vue 3, so the binary is a few megabytes and idles at ~0% CPU.

## Features

- Menubar popover (no dock icon on macOS). The tray pill is a **play/pause button with a clock**: click the button to pause the running timer or resume today's last one, click the time to open and close the popover, and when nothing has run today ("zzzz") a click opens the popover on a new timer. **Right-click** always opens and closes the popover, without touching the clock
- Week strip with per-day totals, ‹ › week navigation, **Jump to Today**
- Day view listing entries with resume ▶ / stop ■ / delete; running entry ticks live
- Running timer shown **next to the menubar icon** (macOS) / tray tooltip elsewhere
- **New Time Entry** sheet: project + task + notes; leave duration empty to start a live timer, or enter `1:30` to log it directly. It opens with the cursor already in the project search, so a new timer is ＋, type, Enter
- ☆ **Presets**: save a project + task you start often from the entry sheet, then start that timer in one press from the searchable list beside ＋; rename or delete them there. Presets are personal and stay on this machine (`localStorage`), filed by workspace
- **Global hotkeys** for five things — start/stop the timer, start a new timer, show/hide the popover, show Insights, show presets — recorded in Settings and registered system-wide
- ⓘ **Time Summary** popover: hours today / yesterday / this week / last week / this month + billable % (served by your own server's widgets)
- Respects invoiced-entry locks and approved-week locks from the server
- Localized into 11 languages (see [docs/i18n.md](docs/i18n.md)); follows the system language, overridable in Settings

## Authentication

No passwords in the app. On the connect screen you name your **workspace** — `studio`, `studio.zebu.work` or a full URL all work — and click **Log in**. Every hosted workspace lives at `https://{workspace}.zebu.work`, and the device flow and API live on that host (never on the central `app.zebu.work` site). The app opens your **browser** to a one-time approval page on your workspace (you must be logged in there), you click **Approve**, and the app receives a per-device token. Revoke it anytime from the workspace, or via "Disconnect this device" in the app's settings; a revoked token drops the app back to the connect screen with an explanation.

Release builds only talk TLS; plain `http://` is accepted for loopback hosts (`localhost`, `127.0.0.1`, `*.localhost`, `*.test`) so a local server works in development. Dev builds can prefill the field via `VITE_ZEBU_WORKSPACE` in `.env` (see `.env.example`).

## Development

Prerequisites: Rust (rustup), Node 20+, and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev
```

The dev server expects a Zebu instance to be reachable (e.g. `http://127.0.0.1:8003` via `composer dev` in the server repo); type its URL into the workspace field, or prefill it with `VITE_ZEBU_WORKSPACE` in `.env`.

## Building & distribution

```bash
npm test          # workspace-address tests + locale parity
npm run lint      # vue-tsc type check
npm run tauri build
```

`npm run tauri build` produces native installers per platform (`.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.rpm`/AppImage on Linux) under `src-tauri/target/release/bundle/`. Because updater artifacts are signed, a local build needs `TAURI_SIGNING_PRIVATE_KEY` in the environment.

Releases are cut by tagging: `git tag v0.2.0 && git push origin v0.2.0` runs `.github/workflows/release.yml`, which builds all three platforms with `tauri-apps/tauri-action`, signs and notarizes (given the secrets), and publishes a draft GitHub Release with the installers and the auto-update manifest. See **[docs/release.md](docs/release.md)** for the updater keypair, code-signing secrets, and how to test an update.

## Server requirements

The companion API ships with the Zebu server (`routes/api.php`): device-flow endpoints (`/api/device/*`), and Sanctum-authenticated `/api/timesheet`, `/api/timer/*`, `/api/time`, `/api/summary`.

Live updates need the server's Laravel Reverb service: when `GET /api/me` returns a `broadcast` block the app subscribes to the person's private channel over a websocket (channel auth via `POST /api/broadcasting/auth`) and hears timer changes within about a hundred milliseconds; without the block it polls the pulse as before.
