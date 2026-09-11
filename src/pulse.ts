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

/** What the pulse endpoint answers. */
export interface Pulse {
    token: string;
    running: boolean;
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
        nextIn: pulse.running ? PULSE.running : PULSE.idle,
        state: {
            token: pulse.token,
            refetchedAt: refetch ? now : state.refetchedAt,
            failedAt: null,
        },
    };
}

/**
 * Fold a fetch the app made for its own reasons — opening the popover, the
 * window regaining focus, starting a timer — into the pulse state, so the
 * five-minute backstop measures time since the last fetch of any kind rather
 * than only the ones this module asked for.
 */
export function refetched(state: PulseState, now: number): PulseState {
    return { ...state, refetchedAt: now };
}
