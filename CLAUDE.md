# Zebu desktop

Tauri 2 menubar timer: Vue 3 + TypeScript frontend (`src/`), Rust shell
(`src-tauri/`) that renders the tray pill, watches OS idle time from a native
thread, and talks to the web app's API (`src/api.ts`).

## Commands

```bash
npm test                  # node --test on tests/*.test.ts + i18n:check
npm run lint              # vue-tsc
(cd src-tauri && cargo test)   # Rust unit tests (idle math, tray rendering)
npm run tauri dev         # run the app
```

Releases: push a `v*` tag; GitHub Actions builds, signs and notarises
(needs `TAURI_SIGNING_PRIVATE_KEY`, `APPLE_*` secrets) and publishes
`latest.json` for the in-app updater.

## Conventions

- Keep the timer focused: anything that is not start/stop/switch/edit-today
  opens the web app instead of growing the popover.
- Idle detection lives in Rust (`spawn_idle_watcher`); the frontend only sets
  the threshold and renders the prompt. Webview timers are throttled while
  hidden, so never rely on `setInterval` for anything time-critical.
- Ten locales in `src/locales`; `npm run i18n:check` after touching text.

## Task board (lite-kan) — shared across the Zebu suite

The MCP server `lite-kan` (https://board.alanwoo.ca) is the task list shared
between Alan and Claude. Alan is the user; assign Claude's items to Claude.

- **Start of every run:** read the board. Act on cards assigned to Claude or
  moved to In progress; treat new comments on those cards as instructions.
- **Anything only Alan can do** (secrets, env keys, DNS, accounts, signing
  keys, manual server edits, purchases) becomes a TODO card assigned to Alan,
  with the exact commands or steps in the description. In chat, point to the
  card instead of repeating the steps.
- **When Alan moves a card to Done,** verify the outcome (test, probe, server
  check), then comment with what was checked. If it did not work, comment and
  move it back to In progress.
- **After each batch of work,** update the cards: comment progress, move
  shipped-and-verified work to Done, add follow-ups as new cards.
- **If the server fails to connect,** say so once, keep working, and list the
  pending Alan-tasks at the end of the final message so nothing is lost.
