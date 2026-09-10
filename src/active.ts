// Which entry the menubar is about, and which answer to believe.
//
// "The last active timer" is not something this app gets to decide any more.
// The server has one definition of it (board #49) and `GET /api/timesheet`
// hands it over: `active` is the running entry when one is running, otherwise
// the entry the user touched most recently — started, stopped, created or
// edited — on their latest day of work. The menubar reads that. It used to
// take the last row of `entries` for today instead, which is ordered by
// `created_at`: stop a timer, edit one, or start one in the browser while an
// older row happened to be created later, and the pill pointed at the wrong
// entry.
//
// Two things still have to be decided here, so they live in this module rather
// than in App.vue, and have tests:
//
//  1. **Reading the answer**, including from a server that has not shipped it
//     yet. `active` absent (not `active: null`, which is a real answer meaning
//     "this user has never tracked anything") means an older workspace, and
//     then the old guess is the best there is.
//
//  2. **Ordering two answers.** The app refetches on a 20-second nudge, on
//     focus, after every write and on every date change, so replies can land
//     out of order; today a late one silently wins. `active_as_of` is the
//     server's own ordering of its answers and settles almost every case.
//     It cannot settle all of them on its own: it moves *backwards* for real
//     when the entry the pill was on is deleted and an older row becomes the
//     answer. So each fetch is numbered too, and an older timestamp is only
//     read as "this reply lost the race" when it also comes from a fetch no
//     later than the one already showing.

/** The fields of an entry payload this module reasons about. */
export interface ActiveCandidate {
    id: string;
    date: string;
    timer_started_at: string | null;
}

/** The parts of `GET /api/timesheet` that say which entry is the active one. */
export interface ActiveResponse<E extends ActiveCandidate> {
    entries: E[];
    running: E | null;
    /**
     * The server's answer. Absent on a workspace older than board #49 — which
     * is why this is optional rather than `E | null`, and why `'active' in
     * response` is the test, not `response.active != null`.
     */
    active?: E | null;
    /** `active`'s `updated_at`, ISO 8601. Null whenever `active` is null. */
    active_as_of?: string | null;
}

/** One reply's answer to "which entry is the menubar about". */
export interface ActiveAnswer<E extends ActiveCandidate> {
    entry: E | null;
    /** `active_as_of` as unix ms, or null when the server did not give one. */
    asOf: number | null;
    /** Which fetch this came back from; fetches are numbered in the order they start. */
    seq: number;
    /** False when the answer was guessed here because the server did not send `active`. */
    derived: boolean;
}

/** ISO 8601 to unix ms, tolerating an absent or unparseable value. */
export function parseAsOf(value: string | null | undefined): number | null {
    if (typeof value !== 'string' || value === '') return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * What the last row of today's entries used to be: the running timer, else the
 * newest-created entry on `today`. Only reached against a server that has not
 * shipped `active` yet — kept so those users see exactly what they saw before
 * rather than an empty pill.
 */
function guessActive<E extends ActiveCandidate>(response: ActiveResponse<E>, today: string): E | null {
    if (response.running) return response.running;
    const todays = (response.entries ?? []).filter((e) => e.date === today);
    return todays.length ? todays[todays.length - 1] : null;
}

/** Read one timesheet reply's answer. `seq` is the fetch it came back from. */
export function readActive<E extends ActiveCandidate>(response: ActiveResponse<E>, seq: number, today: string): ActiveAnswer<E> {
    if ('active' in response) {
        return { entry: response.active ?? null, asOf: parseAsOf(response.active_as_of), seq, derived: false };
    }
    return { entry: guessActive(response, today), asOf: null, seq, derived: true };
}

/**
 * Whether an arriving answer should replace the one on screen.
 *
 * Newer on `active_as_of` always wins. An answer decided *earlier* than the one
 * showing is a slow reply that lost the race — unless it comes from a later
 * fetch, in which case the answer really did move backwards (the active entry
 * was deleted) and it is the current one. With no timestamps to compare (an
 * older workspace, or a user who has never tracked anything) the fetch order is
 * all there is.
 */
export function supersedes<E extends ActiveCandidate>(incoming: ActiveAnswer<E>, held: ActiveAnswer<E> | null): boolean {
    if (held === null) return true;
    if (incoming.asOf !== null && held.asOf !== null) {
        if (incoming.asOf > held.asOf) return true;
        if (incoming.asOf < held.asOf) return incoming.seq > held.seq;
    }
    return incoming.seq >= held.seq;
}

/**
 * The running timer, read off the same answer as everything else — so the pill,
 * the ticking, the idle threshold and the "running on another day" banner can
 * never disagree with the entry the pill is about. The server guarantees
 * `running` is that same row whenever anything is running, and `active` carries
 * `timer_started_at`, so nothing else needs consulting.
 */
export function runningOf<E extends ActiveCandidate>(entry: E | null): E | null {
    return entry && entry.timer_started_at !== null ? entry : null;
}
