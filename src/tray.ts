// What the menubar pill should show, described for the Rust side.
//
// The pill is painted by a native thread (src-tauri: `set_tray_state`,
// `spawn_tray_ticker`) that derives the elapsed time itself every second —
// webview timers stall while the popover is hidden, so the frontend must not
// be the thing that ticks. It only says *what* is on the clock: the banked
// minutes, when the running stretch began, and the localized tooltip with a
// `{time}` placeholder the ticker fills in on each minute rollover.

export interface TrayEntry {
    minutes: number;
    /** Unix ms when the running stretch began; null when the entry is stopped. */
    started_at_ms: number | null;
    /** "project · task", for the tooltip fallback. */
    detail: string | null;
    /** Localized tooltip with a literal `{time}` where the clock goes. */
    tooltip: string | null;
    agent_waiting: boolean;
}

export interface TrayCandidate {
    minutes: number;
    timer_started_at: string | null;
    project: string | null;
    task: string | null;
    agent_waiting?: boolean;
}

/** vue-i18n's `t`, narrowed to what the tooltip needs. */
export type Translate = (key: string, named: Record<string, unknown>) => string;

/** The literal placeholder the Rust ticker substitutes; never localized. */
export const TIME_PLACEHOLDER = '{time}';

/**
 * The tray description for an entry: the running timer when there is one,
 * otherwise today's most recent entry as a paused pill, or null for idle.
 */
export function trayEntry(entry: TrayCandidate | null, t: Translate): TrayEntry | null {
    if (!entry) return null;
    const running = entry.timer_started_at !== null;
    const started = running ? new Date(entry.timer_started_at as string).getTime() : NaN;
    const detail = [entry.project, entry.task].filter(Boolean).join(' · ');
    const tooltip = detail
        ? t(running ? 'tray.tooltipRunning' : 'tray.tooltipStopped', { detail, time: TIME_PLACEHOLDER })
        : t('tray.tooltipIdle', { time: TIME_PLACEHOLDER });
    return {
        minutes: entry.minutes,
        // an unparseable start reads as a stopped entry rather than a frozen clock
        started_at_ms: running && Number.isFinite(started) ? started : null,
        detail: detail || null,
        tooltip,
        agent_waiting: running && !!entry.agent_waiting,
    };
}
