// Unit tests for the idle prompt's decision mapping. Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idleMinutes, resolveIdleChoice } from '../src/idle.ts';

test('removing the idle time is one call, and carries the stop with it', () => {
    assert.deepEqual(resolveIdleChoice({ remove: true, stop: false }), { action: 'discard_keep', stopAfter: false });
    assert.deepEqual(resolveIdleChoice({ remove: true, stop: true }), { action: 'discard_stop', stopAfter: false });
});

test('keeping the idle time sends nothing; stopping is then a plain stop', () => {
    assert.deepEqual(resolveIdleChoice({ remove: false, stop: false }), { action: 'keep', stopAfter: false });
    assert.deepEqual(resolveIdleChoice({ remove: false, stop: true }), { action: 'keep', stopAfter: true });
});

test('the prompt defaults — remove the time, keep timing — discard and keep running', () => {
    assert.deepEqual(resolveIdleChoice({ remove: true, stop: false }), { action: 'discard_keep', stopAfter: false });
});

test('the heading rounds to whole minutes and never says zero', () => {
    assert.equal(idleMinutes(13 * 60), 13);
    assert.equal(idleMinutes(13 * 60 + 29), 13);
    assert.equal(idleMinutes(13 * 60 + 31), 14);
    assert.equal(idleMinutes(20), 1);
    assert.equal(idleMinutes(0), 1);
});
