import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followToday } from '../src/today.ts';

test('a view on today moves to the new today after midnight', () => {
    assert.equal(followToday('2026-10-18', '2026-10-18', '2026-10-19'), '2026-10-19');
});

test('a day picked by hand stays put', () => {
    assert.equal(followToday('2026-10-14', '2026-10-18', '2026-10-19'), '2026-10-14');
});

test('nothing moves while the date is the same', () => {
    assert.equal(followToday('2026-10-18', '2026-10-18', '2026-10-18'), '2026-10-18');
});
