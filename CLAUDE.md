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
Columns: **To Do → In Progress → Review → Done**.

- **Start of every run:** read the board. Act on cards assigned to Claude in
  To Do or In Progress and on cards in Review assigned to Claude; treat new
  comments on those cards as instructions. Move a card to In Progress when
  starting on it.
- **Anything only Alan can do** (secrets, env keys, DNS, accounts, signing
  keys, manual server edits, purchases) becomes a To Do card assigned to
  Alan, with the exact commands or steps in the description. In chat, point
  to the card instead of repeating the steps.
- **Review flow:** whoever finishes a card moves it to Review and assigns it
  to the other person with a comment saying what to check and how. The
  reviewer verifies (test, probe, server check, trying the feature), then
  either moves it to Done with a comment on what was checked, or comments
  with what is wrong and assigns it back to In Progress. Nothing goes
  straight to Done.
- **After each batch of work,** update the cards: comment progress, move
  finished work to Review, add follow-ups as new cards.
- **If the server fails to connect,** say so once, keep working, and list the
  pending Alan-tasks at the end of the final message so nothing is lost.
- **`/board`** (skill in the suite root, `.claude/skills/board`) does one such
  pass on demand; `/loop 10m /board` keeps it running in a session.
