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
  hidden, so never rely on `setInterval` for anything time-critical: the tray
  pill ticks from `spawn_tray_ticker` (the frontend only describes what is on
  the clock via `set_tray_state`, see `src/tray.ts`), and the same thread
  emits `refresh-due` every 20 s for the timesheet re-fetch.
- The idle prompt is its own always-on-top window (`show_idle_prompt`, label
  `idle`, `src/IdlePrompt.vue`) so it is never clipped by the timer list's
  frame; it only presents the question — App.vue still owns what the answers
  do, via the `idle-choice` event.
- Insights is its own window too (`toggle_insights`, label `insights`,
  `src/Insights.vue`), placed beside the popover and sized to what its content
  measures, so the stats and charts are not squeezed into the timer's frame.
  It and the popover hide together only when focus leaves the app.
- The tray pill is two controls (`on_pill_click`): a left-click on the
  play/pause artwork plays or pauses the entry the pill shows
  (`tray-toggle-timer`), one on the clock opens/closes the popover, and on the
  idle "zzzz" pill the whole thing opens the popover on a new timer
  (`tray-open-new-timer`); right-click is always the plain open/close. Rust
  splits the click with `pill_zone` (the drawn pill's width from
  `PILL_WIDTH`, the button's edge at `tray_icon::BUTTON_END`) and branches on
  `TRAY_STATE`; App.vue owns what the two events do, the same split as
  `idle-choice`.
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
- **`/board`** (user-level skill, `~/.claude/skills/board`, shared with Alan's
  other projects) does one such pass on demand; `/loop 10m /board` keeps it
  running in a session.
