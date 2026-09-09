// Unit tests for the duration formatters. Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDurationHuman, formatMinutes, parseDuration } from '../src/duration.ts';

test('under a day, totals are hours and minutes', () => {
    assert.equal(formatDurationHuman(4 * 60 + 5), '4h 5m');
    assert.equal(formatDurationHuman(8 * 60), '8h');
    assert.equal(formatDurationHuman(23 * 60 + 59), '23h 59m');
});

test('from a day on, totals are days and hours — minutes are dropped', () => {
    assert.equal(formatDurationHuman(24 * 60), '1d');
    assert.equal(formatDurationHuman(24 * 60 + 59), '1d'); // 59 minutes no longer shown
    assert.equal(formatDurationHuman(34 * 60), '1d 10h');
    assert.equal(formatDurationHuman(38 * 60 + 12), '1d 14h');
    assert.equal(formatDurationHuman(6 * 24 * 60 + 23 * 60 + 59), '6d 23h');
});

test('from a week on, totals are weeks and days — hours are dropped', () => {
    assert.equal(formatDurationHuman(7 * 24 * 60), '1w');
    assert.equal(formatDurationHuman(7 * 24 * 60 + 23 * 60), '1w'); // 23 hours no longer shown
    assert.equal(formatDurationHuman(9 * 24 * 60 + 5 * 60), '1w 2d');
    assert.equal(formatDurationHuman(500 * 60 + 9), '2w 6d'); // was "500h 9m"
    assert.equal(formatDurationHuman(52 * 7 * 24 * 60), '52w');
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
    const ja = { hour: '時間', minute: '分', day: '日', week: '週' };
    assert.equal(formatDurationHuman(3 * 60 + 12, ja), '3時間 12分');
    assert.equal(formatDurationHuman(38 * 60 + 12, ja), '1日 14時間');
    assert.equal(formatDurationHuman(9 * 24 * 60, ja), '1週 2日');
    assert.equal(formatDurationHuman(5, { hour: 'u', minute: 'm', day: 'd', week: 'w' }), '5m');
});

test('inline totals are never padded: no figure spaces, double spaces or leading zeros', () => {
    // "Total: 4h 5m · Uninvoiced: 1h 5m" has to read as prose even when another
    // project on the same list is at 120h — padding shows up as stray gaps there
    for (const s of [formatDurationHuman(4 * 60 + 5), formatDurationHuman(120 * 60), formatDurationHuman(9), formatDurationHuman(30 * 24 * 60 + 60)]) {
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
