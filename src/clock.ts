/**
 * The server's clock, as best this machine can tell.
 *
 * A running timer stores no elapsed time. It stores when it started, on the
 * server, and every client subtracts that from its own clock — so a machine
 * whose clock is off reports work that never happened, and nothing in the app
 * can notice, because the wrong clock is the one asking. A Mac left asleep
 * with a dead battery and no network comes back minutes out, which is exactly
 * the machine a menubar timer lives on (board #49, decision 4).
 *
 * Every timesheet reply carries the server's time. The drift is recorded from
 * it, and everything that counts a running clock counts against that instead.
 */

/** How far this machine's clock is ahead of the server's, in milliseconds. */
let skew = 0;

/**
 * Record the drift from a payload's `server_time`.
 *
 * Measured the instant the reply lands, so the round trip is not mistaken for
 * drift — a slow reply makes this read a fraction of a second high, which is
 * far below the minute the pill shows. A payload without a server time, or
 * with an unreadable one, leaves the last reading alone rather than resetting
 * to a guess of zero.
 */
export function noteServerTime(serverTime: string | null | undefined): void {
    if (!serverTime) return;
    const server = new Date(serverTime).getTime();
    if (Number.isNaN(server)) return;
    skew = Date.now() - server;
}

export function clockSkewMs(): number {
    return skew;
}

/** Now, on the server's clock. */
export function serverNow(): number {
    return Date.now() - skew;
}

/** Only for tests: forget what was measured. */
export function resetClock(): void {
    skew = 0;
}
