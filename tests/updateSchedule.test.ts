import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECHECK_EVERY_MS, updateCheckDue } from '../src/updateSchedule.ts';

const t0 = Date.UTC(2026, 8, 24, 9, 0, 0);

test('re-checks once six hours have passed since the last check', () => {
    assert.equal(RECHECK_EVERY_MS, 6 * 60 * 60_000);
    assert.equal(updateCheckDue('upToDate', t0, t0 + RECHECK_EVERY_MS - 1), false);
    assert.equal(updateCheckDue('upToDate', t0, t0 + RECHECK_EVERY_MS), true);
    assert.equal(updateCheckDue('idle', t0, t0 + 3 * RECHECK_EVERY_MS), true); // woke from a long sleep
});

test('leaves the first check to the launch timer', () => {
    assert.equal(updateCheckDue('idle', 0, t0), false);
});

test('never overlaps a check, a download, or an update already on offer', () => {
    const later = t0 + RECHECK_EVERY_MS;
    for (const status of ['checking', 'available', 'downloading', 'installing']) assert.equal(updateCheckDue(status, t0, later), false, status);
    assert.equal(updateCheckDue('error', t0, later), true);
});
