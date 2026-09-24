import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayLabel } from '../src/dayLabel.ts';

test('the header date is short weekday, month and day', () => {
    assert.equal(dayLabel('2026-09-24', 'en'), 'Thu Sep 24');
    assert.equal(dayLabel('2026-09-23', 'en'), 'Wed Sep 23');
});

test('other locales keep their own order and words', () => {
    const fr = dayLabel('2026-09-24', 'fr');
    assert.match(fr, /^jeu\. 24 sept\.$/);
    assert.ok(!dayLabel('2026-09-24', 'de').includes(', '));
});
