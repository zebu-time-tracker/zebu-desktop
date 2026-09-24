// When the app looks for a new release on its own (board #421): once shortly
// after launch, then again whenever six hours have passed since the last
// look. "Passed" is wall-clock time, checked on the Rust backstop beat and on
// focus, so a Mac that slept through the six hours checks soon after it wakes
// instead of waiting for a webview timer that was frozen meanwhile.

export const RECHECK_EVERY_MS = 6 * 60 * 60_000;

/** Statuses during which another check would only get in the way. */
const BUSY = new Set(['checking', 'available', 'downloading', 'installing']);

/**
 * Whether a quiet background check should run now. `lastCheckedAt` is 0
 * before the launch check has run: that one has its own timer.
 */
export const updateCheckDue = (status: string, lastCheckedAt: number, now: number, every = RECHECK_EVERY_MS): boolean =>
    lastCheckedAt > 0 && !BUSY.has(status) && now - lastCheckedAt >= every;
