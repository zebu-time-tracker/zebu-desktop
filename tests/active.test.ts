// Which entry the menubar is about, and which reply to believe. Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAsOf, readActive, runningOf, supersedes, type ActiveAnswer, type ActiveCandidate, type ActiveResponse } from '../src/active.ts';

const TODAY = '2026-09-10';

interface Row extends ActiveCandidate {
    minutes: number;
}

const row = (id: string, over: Partial<Row> = {}): Row => ({ id, date: TODAY, minutes: 30, timer_started_at: null, ...over });

const sheet = (over: Partial<ActiveResponse<Row>> = {}): ActiveResponse<Row> => ({ entries: [], running: null, ...over });

// ---- reading the answer ----------------------------------------------------

test("the server's `active` is the answer, whatever the row order says", () => {
    // ordered by created_at, so the entry created last is last — and is not the
    // one that was touched last
    const older = row('a');
    const newer = row('b');
    const response = sheet({ entries: [older, newer], running: null, active: older, active_as_of: '2026-09-10T14:00:00+00:00' });

    const answer = readActive(response, 1, TODAY);
    assert.equal(answer.entry, older);
    assert.equal(answer.derived, false);
    assert.equal(answer.asOf, Date.parse('2026-09-10T14:00:00+00:00'));
});

test('a running timer is the active entry, on whatever day it lives', () => {
    const overnight = row('r', { date: '2026-09-09', timer_started_at: '2026-09-09T22:00:00+00:00' });
    const answer = readActive(sheet({ entries: [row('a')], running: overnight, active: overnight, active_as_of: '2026-09-09T22:00:00+00:00' }), 1, TODAY);
    assert.equal(answer.entry, overnight);
    assert.equal(runningOf(answer.entry), overnight);
});

test('`active: null` is a real answer — the user has never tracked anything', () => {
    const answer = readActive(sheet({ active: null, active_as_of: null }), 1, TODAY);
    assert.equal(answer.entry, null);
    assert.equal(answer.asOf, null);
    assert.equal(answer.derived, false, 'the server answered; nothing to guess');
});

test('a workspace without `active` falls back to what the app used to show', () => {
    const a = row('a');
    const b = row('b');
    const yesterday = row('y', { date: '2026-09-09' });
    const answer = readActive(sheet({ entries: [yesterday, a, b] }), 1, TODAY);
    assert.equal(answer.entry, b, "today's last row, as before");
    assert.equal(answer.derived, true);
    assert.equal(answer.asOf, null);
});

test('the fallback still prefers the running timer', () => {
    const runner = row('r', { date: '2026-09-09', timer_started_at: '2026-09-09T22:00:00+00:00' });
    const answer = readActive(sheet({ entries: [row('a')], running: runner }), 1, TODAY);
    assert.equal(answer.entry, runner);
    assert.equal(answer.derived, true);
});

test('the fallback shows nothing rather than an older day when today is empty', () => {
    const answer = readActive(sheet({ entries: [row('y', { date: '2026-09-09' })] }), 1, TODAY);
    assert.equal(answer.entry, null);
});

test('a missing or unparseable active_as_of is simply unknown', () => {
    assert.equal(parseAsOf(undefined), null);
    assert.equal(parseAsOf(null), null);
    assert.equal(parseAsOf(''), null);
    assert.equal(parseAsOf('not a date'), null);
    assert.equal(parseAsOf('2026-09-10T14:00:00+00:00'), 1_789_048_800_000);
    // an unreadable timestamp must not cost us the entry itself
    const only = row('a');
    assert.equal(readActive(sheet({ active: only, active_as_of: 'garbage' }), 1, TODAY).entry, only);
});

// ---- ordering two answers --------------------------------------------------

const at = (iso: string | null, seq: number, entry: Row | null = row('a')): ActiveAnswer<Row> => ({
    entry,
    asOf: parseAsOf(iso),
    seq,
    derived: false,
});

test('the first answer always lands', () => {
    assert.equal(supersedes(at('2026-09-10T14:00:00Z', 1), null), true);
});

test('a newer answer replaces the one on screen', () => {
    const held = at('2026-09-10T14:00:00Z', 1);
    assert.equal(supersedes(at('2026-09-10T14:05:00Z', 2), held), true);
});

test('a slow reply cannot overwrite the fresher answer that beat it home', () => {
    // fetch 4 hangs; the user starts a timer, fetch 5 comes back with it; then 4 lands
    const held = at('2026-09-10T14:05:00Z', 5);
    assert.equal(supersedes(at('2026-09-10T14:00:00Z', 4), held), false);
});

test('an out-of-order reply with the same answer is dropped too', () => {
    const held = at('2026-09-10T14:05:00Z', 5);
    assert.equal(supersedes(at('2026-09-10T14:05:00Z', 4), held), false);
});

test('the same answer from the next fetch is accepted — the usual quiet poll', () => {
    const held = at('2026-09-10T14:05:00Z', 5);
    assert.equal(supersedes(at('2026-09-10T14:05:00Z', 6), held), true);
});

test('deleting the active entry moves the answer backwards, and that is not stale', () => {
    // the pill was on an entry edited at 14:05; it is deleted in the browser and
    // an older row becomes the answer. A later fetch says so, and is believed.
    const held = at('2026-09-10T14:05:00Z', 5, row('a'));
    assert.equal(supersedes(at('2026-09-10T13:00:00Z', 6, row('b')), held), true);
});

test('with no timestamps to compare, fetch order decides', () => {
    const held = at(null, 5);
    assert.equal(supersedes(at(null, 6), held), true);
    assert.equal(supersedes(at(null, 4), held), false);
    assert.equal(supersedes(at(null, 5), held), true, 'the same fetch is not a race');
});

test('an answer that gained a timestamp is not thrown away for the ones that had none', () => {
    assert.equal(supersedes(at('2026-09-10T14:00:00Z', 6), at(null, 5)), true);
    assert.equal(supersedes(at(null, 6, null), at('2026-09-10T14:00:00Z', 5)), true, 'the last entry was deleted');
});

// ---- running-ness comes from the same answer -------------------------------

test('the pill ticks only while the entry it shows is running', () => {
    assert.equal(runningOf(null), null);
    assert.equal(runningOf(row('a')), null);
    const runner = row('r', { timer_started_at: '2026-09-10T14:00:00+00:00' });
    assert.equal(runningOf(runner), runner);
});
