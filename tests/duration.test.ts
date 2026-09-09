// Unit tests for the duration formatters. Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDurationHuman, formatMinutes, parseDuration } from '../src/duration.ts';

test('tracked totals are hours and minutes, never days', () => {
    assert.equal(formatDurationHuman(38 * 60 + 12), '38h 12m');
    assert.equal(formatDurationHuman(38 * 60), '38h');
    assert.equal(formatDurationHuman(8 * 60), '8h'); // was "1d"
    assert.equal(formatDurationHuman(34 * 60), '34h'); // was "4d 2h"
    assert.equal(formatDurationHuman(40 * 60), '40h'); // was "1w"
});

test('over 100 hours still reads in hours', () => {
    assert.equal(formatDurationHuman(100 * 60), '100h');
    assert.equal(formatDurationHuman(1234 * 60 + 5), '1234h 5m');
});

test('under an hour is minutes only, zero is 0m', () => {
    assert.equal(formatDurationHuman(45), '45m');
    assert.equal(formatDurationHuman(1), '1m');
    assert.equal(formatDurationHuman(0), '0m');
    assert.equal(formatDurationHuman(-30), '0m');
});

test('fractional minutes (a ticking timer) round to whole minutes', () => {
    assert.equal(formatDurationHuman(59.6), '1h');
    assert.equal(formatDurationHuman(90.4), '1h 30m');
});

test('unit labels come from the caller', () => {
    assert.equal(formatDurationHuman(38 * 60 + 12, { hour: '時間', minute: '分' }), '38時間 12分');
    assert.equal(formatDurationHuman(5, { hour: 'u', minute: 'm' }), '5m');
});

test('inline totals are never padded: no figure spaces, double spaces or leading zeros', () => {
    // "Total: 4h 5m · Uninvoiced: 1h 5m" has to read as prose even when another
    // project on the same list is at 120h — padding shows up as stray gaps there
    for (const s of [formatDurationHuman(4 * 60 + 5), formatDurationHuman(120 * 60), formatDurationHuman(9)]) {
        assert.doesNotMatch(s, / | | {2}|\b0\d/, s);
    }
    assert.equal(formatDurationHuman(4 * 60 + 5), '4h 5m');
});

test('formatMinutes is clock style h:mm', () => {
    assert.equal(formatMinutes(0), '0:00');
    assert.equal(formatMinutes(5), '0:05');
    assert.equal(formatMinutes(90), '1:30');
    assert.equal(formatMinutes(38 * 60 + 12), '38:12');
    assert.equal(formatMinutes(89.7), '1:30');
});

test('parseDuration accepts h:mm, decimal hours and Nm', () => {
    assert.equal(parseDuration('1:30'), 90);
    assert.equal(parseDuration('1.5'), 90);
    assert.equal(parseDuration('1,5'), 90);
    assert.equal(parseDuration('90m'), 90);
    assert.equal(parseDuration(' 2 '), 120);
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('abc'), null);
});
