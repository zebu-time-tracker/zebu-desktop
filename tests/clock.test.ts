// The server's clock, and what the pill counts against. Run with `npm test`.
//
// A running timer stores no elapsed time; it stores when it started, on the
// server. A machine whose clock is off reports work that never happened, and
// nothing can notice, because the wrong clock is the one asking (board #49).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockSkewMs, noteServerTime, resetClock, serverNow } from '../src/clock.ts';
import { elapsedMinutes } from '../src/duration.ts';
import { trayEntry } from '../src/tray.ts';

const t = (key: string, named: Record<string, unknown>) => `${key}|${named.detail ?? ''}|${named.time}`;

const FIVE_MINUTES = 5 * 60_000;

test('a machine in step with the server measures no drift', () => {
    resetClock();
    noteServerTime(new Date().toISOString());

    assert.ok(Math.abs(clockSkewMs()) < 1000, 'a fraction of a second of round trip, no more');
    resetClock();
});

test('a fast machine records the drift and counts against the server', () => {
    resetClock();
    // This machine believes it is five minutes later than the server does.
    const serverTime = new Date(Date.now() - FIVE_MINUTES);
    noteServerTime(serverTime.toISOString());

    assert.ok(clockSkewMs() >= FIVE_MINUTES - 1000 && clockSkewMs() <= FIVE_MINUTES + 1000);

    // A timer the server started one minute before its own "now".
    const startedAt = new Date(serverTime.getTime() - 60_000).toISOString();
    const minutes = elapsedMinutes({ minutes: 0, timer_started_at: startedAt }, serverNow());

    assert.ok(minutes >= 0.9 && minutes <= 1.1, `one minute of work, not six — got ${minutes}`);
    resetClock();
});

test('no server time, or an unreadable one, leaves the last reading alone', () => {
    resetClock();
    noteServerTime(new Date(Date.now() - FIVE_MINUTES).toISOString());
    const measured = clockSkewMs();

    noteServerTime(null);
    noteServerTime(undefined);
    noteServerTime('');
    noteServerTime('not a timestamp');

    assert.equal(clockSkewMs(), measured);
    resetClock();
});

test('the pill is handed a start shifted by the drift, since Rust ticks on this machine', () => {
    // Rust counts from started_at_ms against the machine's own clock, so the
    // start has to move by the drift for the pill to show the real elapsed.
    const startedAt = '2026-09-09T10:00:00+00:00';
    const entry = trayEntry({ minutes: 20, timer_started_at: startedAt, project: 'Acme', task: null }, t, FIVE_MINUTES);

    assert.equal(entry?.started_at_ms, Date.parse(startedAt) + FIVE_MINUTES);
});

test('a machine in step shifts nothing, so the pill is unchanged', () => {
    const startedAt = '2026-09-09T10:00:00+00:00';
    const entry = trayEntry({ minutes: 20, timer_started_at: startedAt, project: 'Acme', task: null }, t, 0);

    assert.equal(entry?.started_at_ms, Date.parse(startedAt));
});
