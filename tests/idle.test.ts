// Unit tests for idle detection's decisions (board #333). Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityDue, askMatchesRunning, askStillOpen, idleAction, idleMinutes, idleQuestion, newEntryFrom, type IdleAnswer } from '../src/idle.ts';

const running = { id: 'E1', timer_started_at: '2026-09-22T09:00:00+00:00' };

const answer = (over: Partial<IdleAnswer> = {}): IdleAnswer => ({
    entry_id: 'E1',
    timer_started_at: '2026-09-22T09:00:00+00:00',
    last_activity_at: '2026-09-22T09:03:00+00:00',
    idle_resolved_until: null,
    idle_since: '2026-09-22T09:03:00+00:00',
    idle_until: null,
    idle_seconds: 7200,
    pending: false,
    server_time: '2026-09-22T11:03:00+00:00',
    ...over,
});

test('asks about an absence at or past the user threshold, in the server minutes', () => {
    assert.deepEqual(idleQuestion(answer(), running, 10), {
        entryId: 'E1',
        timerStartedAt: '2026-09-22T09:00:00+00:00',
        idleSince: '2026-09-22T09:03:00+00:00',
        minutes: 120,
    });
    assert.equal(idleQuestion(answer({ idle_seconds: 600 }), running, 10)?.minutes, 10);
    // a pending gap is asked about the same way
    assert.equal(idleQuestion(answer({ pending: true, idle_until: '2026-09-22T11:00:00+00:00', idle_seconds: 7020 }), running, 10)?.minutes, 117);
});

test('a night away is the server count, not a local one', () => {
    // the OS counter might have said a few minutes; the server saw eleven hours
    assert.equal(idleQuestion(answer({ idle_seconds: 11 * 3600 }), running, 10)?.minutes, 660);
});

test('no prompt under the threshold — including an absence already answered elsewhere', () => {
    assert.equal(idleQuestion(answer({ idle_seconds: 599 }), running, 10), null);
    // answered on the laptop: idle_resolved_until moved, so the live stretch is short
    assert.equal(idleQuestion(answer({ idle_resolved_until: '2026-09-22T11:02:00+00:00', idle_since: '2026-09-22T11:02:00+00:00', idle_seconds: 60 }), running, 10), null);
});

test('no prompt with detection off, nothing running, or no idle_since', () => {
    assert.equal(idleQuestion(answer(), running, null), null);
    assert.equal(idleQuestion(answer(), null, 10), null);
    assert.equal(idleQuestion(answer({ entry_id: null, timer_started_at: null, idle_since: null, idle_seconds: 0 }), running, 10), null);
    assert.equal(idleQuestion(answer({ idle_since: null }), running, 10), null);
});

test('a stale answer about another timer never prompts', () => {
    assert.equal(idleQuestion(answer({ entry_id: 'E2' }), running, 10), null);
    // same row, restarted: a different clock
    assert.equal(idleQuestion(answer({ timer_started_at: '2026-09-22T10:00:00+00:00' }), running, 10), null);
    // the same instant written with another offset is the same timer
    assert.ok(idleQuestion(answer({ timer_started_at: '2026-09-22T11:00:00+02:00' }), running, 10));
});

test('an open prompt closes when answered elsewhere, stopped, or switched', () => {
    const ask = idleQuestion(answer(), running, 10)!;
    // activity since turned the stretch into a gap with the same start: still open
    assert.equal(askStillOpen(ask, answer({ pending: true, idle_until: '2026-09-22T11:03:00+00:00' })), true);
    // answered on another device: idle_since moved on
    assert.equal(askStillOpen(ask, answer({ idle_since: '2026-09-22T11:05:00+00:00', idle_seconds: 30 })), false);
    // stopped elsewhere
    assert.equal(askStillOpen(ask, answer({ entry_id: null, timer_started_at: null, idle_since: null, idle_seconds: 0 })), false);
    // another timer started
    assert.equal(askStillOpen(ask, answer({ entry_id: 'E2' })), false);
    assert.equal(askStillOpen(ask, answer({ timer_started_at: '2026-09-22T11:04:00+00:00' })), false);
});

test('the timesheet alone can close the prompt', () => {
    const ask = idleQuestion(answer(), running, 10)!;
    assert.equal(askMatchesRunning(ask, running), true);
    assert.equal(askMatchesRunning(ask, null), false);
    assert.equal(askMatchesRunning(ask, { id: 'E2', timer_started_at: running.timer_started_at }), false);
    assert.equal(askMatchesRunning(ask, { id: 'E1', timer_started_at: '2026-09-22T11:04:00+00:00' }), false);
});

test('each button is its Harvest action; anything else keeps the time', () => {
    assert.equal(idleAction('stop'), 'discard_stop');
    assert.equal(idleAction('continue'), 'discard_keep');
    assert.equal(idleAction('new_entry'), 'discard_new_entry');
    assert.equal(idleAction('ignore'), 'keep');
    assert.equal(idleAction('toString'), 'keep');
    assert.equal(idleAction(''), 'keep');
});

test('"add as a new entry" opens the sheet only for the device whose answer applied', () => {
    const idle = { started_at: '2026-09-22T09:03:00', ended_at: '2026-09-22T11:03:00', minutes: 120 };
    assert.deepEqual(newEntryFrom('discard_new_entry', { applied: true, idle }), { date: '2026-09-22', minutes: 120 });
    // a second answer (another device got there first) opens nothing
    assert.equal(newEntryFrom('discard_new_entry', { applied: false, idle: null }), null);
    assert.equal(newEntryFrom('discard_new_entry', null), null);
    // the other actions never open it
    assert.equal(newEntryFrom('discard_stop', { applied: true, idle }), null);
    assert.equal(newEntryFrom('keep', { applied: true, idle }), null);
    assert.equal(newEntryFrom('discard_new_entry', { applied: true, idle: { ...idle, minutes: 0 } }), null);
});

test('activity is reported at most once a minute', () => {
    assert.equal(activityDue(null, 1_000), true);
    assert.equal(activityDue(1_000, 60_999), false);
    assert.equal(activityDue(1_000, 61_000), true);
});

test('the prompt rounds to whole minutes and never says zero', () => {
    assert.equal(idleMinutes(13 * 60), 13);
    assert.equal(idleMinutes(13 * 60 + 29), 13);
    assert.equal(idleMinutes(13 * 60 + 31), 14);
    assert.equal(idleMinutes(20), 1);
    assert.equal(idleMinutes(0), 1);
});
