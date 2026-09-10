// What the popover keeps, and what it drops, when it comes back. Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAFT_TTL_MS, draftTouched, planReopen, STALE_AFTER_MS, takeDraft, type EntryDraft } from '../src/popover.ts';

const prefill: EntryDraft = { project_id: 'p1', task_id: '', notes: '', duration: '', date: '2026-09-10' };

test('a glance at another app leaves everything exactly as it was', () => {
    assert.deepEqual(planReopen({ awayMs: 0, sheet: 'new', dirty: true }), { clear: false, stash: false });
    assert.deepEqual(planReopen({ awayMs: STALE_AFTER_MS - 1, sheet: 'edit', dirty: true }), { clear: false, stash: false });
});

test('past the grace period the popover comes back on the plain timesheet', () => {
    assert.deepEqual(planReopen({ awayMs: STALE_AFTER_MS, sheet: 'new', dirty: false }), { clear: true, stash: false });
    assert.deepEqual(planReopen({ awayMs: 10 * 60_000, sheet: 'none', dirty: false }), { clear: true, stash: false });
});

test('a new entry with typed work in it is stashed, not dropped', () => {
    assert.deepEqual(planReopen({ awayMs: 10 * 60_000, sheet: 'new', dirty: true }), { clear: true, stash: true });
});

test('an edit is never stashed — its values came from a timesheet that has moved on', () => {
    assert.deepEqual(planReopen({ awayMs: 10 * 60_000, sheet: 'edit', dirty: true }), { clear: true, stash: false });
});

test('an idle absence is never a glance away', () => {
    assert.deepEqual(planReopen({ awayMs: Number.POSITIVE_INFINITY, sheet: 'new', dirty: true }), { clear: true, stash: true });
    assert.deepEqual(planReopen({ awayMs: Number.POSITIVE_INFINITY, sheet: 'edit', dirty: false }), { clear: true, stash: false });
});

test('an untouched sheet holds nothing worth keeping', () => {
    assert.equal(draftTouched({ ...prefill }, prefill), false);
});

test('anything the user put in counts as typed work', () => {
    assert.equal(draftTouched({ ...prefill, notes: 'half a note' }, prefill), true);
    assert.equal(draftTouched({ ...prefill, duration: '0:25' }, prefill), true);
    assert.equal(draftTouched({ ...prefill, project_id: 'p2' }, prefill), true);
    assert.equal(draftTouched({ ...prefill, task_id: 't1' }, prefill), true);
    assert.equal(draftTouched({ ...prefill, date: '2026-09-09' }, prefill), true);
});

test('a stashed draft is offered back until it goes stale', () => {
    const now = 1_800_000_000_000;
    assert.deepEqual(takeDraft({ draft: prefill, at: now }, now), prefill);
    assert.deepEqual(takeDraft({ draft: prefill, at: now - DRAFT_TTL_MS + 1 }, now), prefill);
    assert.equal(takeDraft({ draft: prefill, at: now - DRAFT_TTL_MS }, now), null);
    assert.equal(takeDraft(null, now), null);
});

test('a clock that jumped backwards does not resurrect a draft', () => {
    const now = 1_800_000_000_000;
    assert.equal(takeDraft({ draft: prefill, at: now + 5_000 }, now), null);
});
