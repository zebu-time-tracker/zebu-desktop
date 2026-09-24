// Idle detection's decisions, none of which performs a fetch (board #333).
//
// The server owns idle now. This app used to keep "idle since" to itself, from
// the OS counter, so a night away could be under-counted and a prompt already
// answered on another device was asked again here. Now Rust only says "input
// is happening" (reported as activity, at most once a minute) and "the person
// came back" (answered by asking the server what to prompt about). What that
// answer means — ask or not, which answer is which action, and when an open
// prompt has gone stale — is all here, so it is testable without a webview.

/** `GET /api/timer/idle`. */
export interface IdleAnswer {
    entry_id: string | null;
    timer_started_at: string | null;
    last_activity_at?: string | null;
    idle_resolved_until?: string | null;
    /** When the absence began: a pending gap's start, else when the person was last seen. */
    idle_since: string | null;
    idle_until: string | null;
    idle_seconds: number;
    pending: boolean;
    server_time?: string;
}

/** The running entry as this window last saw it. */
export interface RunningTimer {
    id: string;
    timer_started_at: string | null;
}

/** An absence the prompt is asking about. */
export interface IdleAsk {
    entryId: string;
    timerStartedAt: string | null;
    /** Sent back verbatim as `idle_started_at`: it is what identifies the question. */
    idleSince: string;
    minutes: number;
}

export const IDLE_CHOICES = ['stop', 'continue', 'new_entry', 'ignore'] as const;
export type IdleChoice = (typeof IDLE_CHOICES)[number];
export type IdleAction = 'keep' | 'discard_keep' | 'discard_stop' | 'discard_new_entry';

/** `POST /api/timer/idle`. */
export interface IdleReply {
    applied: boolean;
    idle: { started_at: string; ended_at: string; minutes: number } | null;
}

/** Activity is reported at most this often. */
export const ACTIVITY_EVERY_MS = 60_000;

/** Whole minutes away, as the prompt words it — an absence is never "0 minutes". */
export const idleMinutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));

/** Two ISO stamps for the same instant, whatever offset each was written in. */
export const sameInstant = (a: string | null | undefined, b: string | null | undefined): boolean => {
    if (!a || !b) return !a && !b;
    const x = Date.parse(a);
    const y = Date.parse(b);
    return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
};

/** Whether the server's answer is about the timer this window has running. */
const sameTimer = (entryId: string | null, startedAt: string | null, running: RunningTimer): boolean =>
    entryId === running.id && (!startedAt || !running.timer_started_at || sameInstant(startedAt, running.timer_started_at));

/**
 * What to ask, if anything, from the server's answer. `thresholdMinutes` is
 * the user's own setting (null = idle detection off). No prompt when nothing
 * runs, when the answer is about another timer than the one on screen (it
 * changed meanwhile), or when the absence is shorter than the threshold —
 * including because it was already answered on another device.
 */
export const idleQuestion = (answer: IdleAnswer, running: RunningTimer | null, thresholdMinutes: number | null): IdleAsk | null => {
    if (thresholdMinutes === null || !running || !answer.entry_id || !answer.idle_since) return null;
    if (!sameTimer(answer.entry_id, answer.timer_started_at, running)) return null;
    if (!(answer.idle_seconds >= Math.max(1, thresholdMinutes) * 60)) return null;
    return {
        entryId: answer.entry_id,
        timerStartedAt: answer.timer_started_at,
        idleSince: answer.idle_since,
        minutes: idleMinutes(answer.idle_seconds),
    };
};

/**
 * Whether an open prompt still stands after a fresh answer. It closes when
 * nothing runs, when the timer changed, or when `idle_since` moved — someone
 * answered it elsewhere.
 */
export const askStillOpen = (ask: IdleAsk, answer: IdleAnswer): boolean =>
    !!answer.entry_id &&
    sameTimer(answer.entry_id, answer.timer_started_at, { id: ask.entryId, timer_started_at: ask.timerStartedAt }) &&
    sameInstant(answer.idle_since, ask.idleSince);

/** Whether the prompt still matches what the timesheet shows running — no fetch needed to close it when not. */
export const askMatchesRunning = (ask: IdleAsk, running: RunningTimer | null): boolean =>
    !!running && sameTimer(ask.entryId, ask.timerStartedAt, running);

/** Each of the prompt's four buttons, as the action the server applies. */
const ACTIONS: Record<IdleChoice, IdleAction> = { stop: 'discard_stop', continue: 'discard_keep', new_entry: 'discard_new_entry', ignore: 'keep' };
/** Anything the prompt window sends that is not one of the four is "Ignore": the time stays on the clock. */
export const idleAction = (choice: string): IdleAction => (Object.prototype.hasOwnProperty.call(ACTIONS, choice) ? ACTIONS[choice as IdleChoice] : 'keep');

/** A local calendar day, YYYY-MM-DD. */
const localDate = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * "Add X minutes as a new entry": what the new-entry sheet opens with, or null
 * when there is nothing to add. A reply that was not applied means another
 * device answered first — and only that device opens the sheet.
 */
export const newEntryFrom = (action: IdleAction, reply: IdleReply | null): { date: string; minutes: number } | null => {
    if (action !== 'discard_new_entry' || !reply?.applied || !reply.idle || !(reply.idle.minutes > 0)) return null;
    const started = Date.parse(reply.idle.started_at);
    if (Number.isNaN(started)) return null;
    return { date: localDate(started), minutes: reply.idle.minutes };
};

/** Whether input seen now should be reported: at most once a minute. */
export const activityDue = (lastSentMs: number | null, nowMs: number): boolean => lastSentMs === null || nowMs - lastSentMs >= ACTIVITY_EVERY_MS;
