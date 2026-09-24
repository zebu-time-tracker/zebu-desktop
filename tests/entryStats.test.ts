import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetLevel, formatHours } from '../src/entryStats.ts';

test('uninvoiced time is a plain hour count', () => {
    assert.equal(formatHours(0, 'en'), '0h');
    assert.equal(formatHours(1, 'en'), '0.1h'); // a few minutes are not nothing
    assert.equal(formatHours(90, 'en'), '1.5h');
    assert.equal(formatHours(120, 'en'), '2h');
    assert.equal(formatHours(570, 'en'), '9.5h');
    assert.equal(formatHours(593, 'en'), '9.9h');
    assert.equal(formatHours(610, 'en'), '10h');
    assert.equal(formatHours(1920, 'en'), '32h');
    assert.equal(formatHours(60 * 250, 'en'), '250h'); // never days
});

test('hours use the locale decimal separator and hour unit', () => {
    assert.equal(formatHours(90, 'de'), '1,5h');
    assert.equal(formatHours(90, 'ja', '時間'), '1.5時間');
});

test('budget turns amber from 60% and red from 80%', () => {
    assert.equal(budgetLevel(0), 'ok');
    assert.equal(budgetLevel(59), 'ok');
    assert.equal(budgetLevel(60), 'warn');
    assert.equal(budgetLevel(79), 'warn');
    assert.equal(budgetLevel(80), 'alarm');
    assert.equal(budgetLevel(140), 'alarm');
});
