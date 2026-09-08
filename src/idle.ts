// The idle prompt's two decisions, and how they map onto the timer API.
//
// The prompt asks them as yes/no questions — "Remove Idle Time?" and
// "Continue Timing?" — but the underlying choices are the ones the app has
// always made: keep or drop the stretch spent away, and leave the timer
// running or stop it. Kept here (rather than in the component) because the
// prompt now lives in its own window and the mapping is worth testing.

export interface IdleChoice {
    /** "Remove Idle Time?" answered yes: the time away comes off the entry. */
    remove: boolean;
    /** "Continue Timing?" answered no: the timer stops. */
    stop: boolean;
}

export interface IdleResolution {
    /** What to POST to /timer/idle; 'keep' means there is nothing to send. */
    action: 'keep' | 'discard_keep' | 'discard_stop';
    /** Keeping the idle time but stopping is a plain stop, its own call. */
    stopAfter: boolean;
}

export const resolveIdleChoice = ({ remove, stop }: IdleChoice): IdleResolution =>
    remove ? { action: stop ? 'discard_stop' : 'discard_keep', stopAfter: false } : { action: 'keep', stopAfter: stop };

/** Whole minutes away, as the heading words it — an absence is never "0 minutes". */
export const idleMinutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));
