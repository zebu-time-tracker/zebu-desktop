/* Deciding what to do with each beat of the timer pulse.
 *
 * The menubar used to learn about a timer started anywhere else by refetching
 * the whole timesheet every twenty seconds. The server now answers a much
 * smaller question — "has the active timer changed?", a version token and a
 * running flag — so the app can ask that often and fetch the real payload only
 * when the answer moves.
 *
 * The cadences are the web app's (resources/js/lib/timer.ts there), on purpose:
 * a person watching the same timer in a browser tab and in the menubar should
 * not see one of them notice a stop a quarter of a minute before the other.
 *
 * This file is only the decision. It performs no fetch and holds no timer, so
 * every rule in it can be tested without a webview, a token or a clock.
 */

/** An outage the server has announced ahead of time. Both ISO 8601. */
export interface MaintenanceWindow {
    starts_at: string;
    ends_at: string;
}

/** What the pulse endpoint answers. */
export interface Pulse {
    token: string;
    running: boolean;
    /**
     * Present only while an outage is announced and not yet over. The box is
     * about to go down for a move or a rescale; see the server's
     * docs/api.md § Planned outages (board #216).
     */
    maintenance?: MaintenanceWindow | null;
}

export const PULSE = {
    /** Ask again this soon while a timer is running. */
    running: 2_000,
    /**
     * …and this soon while none is, which is most of the day for an app that
     * sits in the menubar from login to shutdown. Nothing can change the
     * answer until somebody starts something, and this is no more often than
     * the app already polled.
     */
    idle: 30_000,
    /**
     * And this soon while the pulse cannot be reached, when every beat costs a
     * full refetch again. Retrying at the running cadence would turn an outage
     * of the cheap endpoint into fifteen times the load on the expensive one —
     * worse than the problem it is failing at.
     */
    unreachable: 30_000,
    /** Refetch everything on this beat whatever the pulse says. */
    fallback: 5 * 60_000,
    /**
     * How long past an announced window's end to wait before asking again. The
     * work finishes when it finishes, rarely on the minute — and every client
     * holds the same end time, so arriving a little after it keeps them from
     * arriving together.
     */
    grace: 15_000,
    /**
     * The longest a single wait may be. A window can be hours, and one sleep
     * that long would miss a box that came back early — and would be measured
     * by a machine that may itself have slept. Checking back on this cadence
     * costs one refused request.
     */
    maxHold: 5 * 60_000,
} as const;

/** What the app knows between beats. Plain data so the decision stays testable. */
export interface PulseState {
    /** The last token seen, or null before the first successful read. */
    token: string | null;
    /** When we last refetched the timesheet, in ms since the epoch. */
    refetchedAt: number;
    /**
     * When the pulse last failed, or null while it is answering. Null rather
     * than 0, because 0 is a real instant: treating "never failed" as "failed
     * at the epoch" would make the first failure of a session wait out the
     * whole backoff before refetching, which is precisely the moment it should
     * not.
     */
    failedAt: number | null;
}

export const initialPulseState = (): PulseState => ({ token: null, refetchedAt: 0, failedAt: null });

export interface PulseDecision {
    /** Fetch the timesheet now. */
    refetch: boolean;
    /** How long until the next beat should be asked for. */
    nextIn: number;
    /** The state to carry into the next beat. */
    state: PulseState;
}

/**
 * What to do with one beat.
 *
 * `pulse` is null when the endpoint could not be read at all — an old
 * workspace without the route, an expired token, a laptop that just woke with
 * no network. That case still has to converge, so it refetches, but slowly.
 *
 * The first successful read never refetches on its own account. Learning the
 * token for the first time says nothing about whether anything changed, and
 * treating it as a change would mean a redundant full fetch every time the app
 * starts or the token is re-learned after an outage.
 */
export function onPulse(pulse: Pulse | null, state: PulseState, now: number): PulseDecision {
    if (pulse === null) {
        const due = state.failedAt === null || now - state.failedAt >= PULSE.unreachable;

        return {
            refetch: due,
            nextIn: PULSE.unreachable,
            // Only a beat that actually refetched resets the clock, or a run of
            // failures arriving faster than the backoff would never refetch.
            state: { ...state, failedAt: due ? now : state.failedAt, refetchedAt: due ? now : state.refetchedAt },
        };
    }

    const first = state.token === null;
    const moved = !first && pulse.token !== state.token;
    const stale = now - state.refetchedAt >= PULSE.fallback;
    const refetch = moved || stale;

    return {
        refetch,
        nextIn: holdFor(pulse.maintenance, now, pulse.running ? PULSE.running : PULSE.idle),
        state: {
            token: pulse.token,
            refetchedAt: refetch ? now : state.refetchedAt,
            failedAt: null,
        },
    };
}

/**
 * How long to wait before the next beat, given an announced outage.
 *
 * Nothing has changed until the window starts, so the usual cadence stands —
 * right up until the beat it would schedule lands inside the outage, at which
 * point there is no reason to make that request at all. From then on the wait
 * runs to the end of the window.
 *
 * A window whose times cannot be read is no window: an announcement the client
 * does not understand must not stop it polling.
 */
export function holdFor(window: MaintenanceWindow | null | undefined, now: number, normal: number): number {
    if (!window) return normal;

    const starts = Date.parse(window.starts_at);
    const ends = Date.parse(window.ends_at);

    if (!Number.isFinite(starts) || !Number.isFinite(ends)) return normal;
    // Already over, or the next beat still lands before it begins.
    if (now >= ends || now + normal < starts) return normal;

    return clampHold(ends + PULSE.grace - now);
}

/**
 * The server refused the beat: it is down for the announced window, and
 * `Retry-After` said how long to wait.
 *
 * Nothing is refetched. Unlike a server that cannot be reached there is
 * nothing to converge on — the full payload would be refused too, and asking
 * for it is exactly the hammering the header exists to prevent.
 */
export function onUnavailable(retryInMs: number | null, state: PulseState, now: number): PulseDecision {
    return {
        refetch: false,
        nextIn: clampHold(retryInMs ?? PULSE.unreachable),
        state: { ...state, failedAt: now },
    };
}

/** Never sooner than the grace, never longer than one hold. */
const clampHold = (ms: number): number => Math.min(Math.max(ms, PULSE.grace), PULSE.maxHold);

/**
 * The seconds a `Retry-After` header asks for, or null when it does not say
 * anything usable — a missing header, junk, zero, or the HTTP-date form, which
 * this server does not send. Null means "unknown", never "come straight back".
 *
 * It lives here rather than beside the fetch so it can be tested: this module
 * is the one part of the beat that needs no webview and no token.
 */
export const retryAfterSeconds = (header: string | null): number | null => {
    const seconds = Number(header);

    return header !== null && header.trim() !== '' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

/**
 * The announced window off a pulse payload, or null.
 *
 * Both times have to be readable dates. An announcement the client only half
 * understands must not stop it polling — that would take the app quiet on no
 * evidence at all, against a server that is perfectly well.
 */
export const readWindow = (value: unknown): MaintenanceWindow | null => {
    const window = value as Partial<MaintenanceWindow> | null | undefined;

    if (!window || typeof window.starts_at !== 'string' || typeof window.ends_at !== 'string') return null;

    return Number.isFinite(Date.parse(window.starts_at)) && Number.isFinite(Date.parse(window.ends_at))
        ? { starts_at: window.starts_at, ends_at: window.ends_at }
        : null;
};

/**
 * Fold a fetch the app made for its own reasons — opening the popover, the
 * window regaining focus, starting a timer — into the pulse state, so the
 * five-minute backstop measures time since the last fetch of any kind rather
 * than only the ones this module asked for.
 */
export function refetched(state: PulseState, now: number): PulseState {
    return { ...state, refetchedAt: now };
}
