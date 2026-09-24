import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectOption } from '../src/api.ts';
import { clientOf, lastTimerProject, relativeDay, resumeLabelKey, splitAround } from '../src/lastTimer.ts';

const project = (over: Partial<ProjectOption> = {}): ProjectOption => ({
    id: 'proj-1',
    name: 'Website',
    code: null,
    client: 'Acme',
    tasks: [],
    ...over,
});

test('the project line reads project · task', () => {
    assert.equal(lastTimerProject({ project: 'Website', task: 'Design' }), 'Website · Design');
    assert.equal(lastTimerProject({ project: 'Website', task: null }), 'Website');
    assert.equal(lastTimerProject({ project: null, task: 'Design' }), 'Design');
});

test('clientOf finds the client in the timesheet projects', () => {
    assert.equal(clientOf([project()], 'proj-1'), 'Acme');
    assert.equal(clientOf([project({ client: null })], 'proj-1'), null);
    assert.equal(clientOf([project()], 'other'), null);
    assert.equal(clientOf(undefined, 'proj-1'), null);
});

test('an earlier day says start new, today says resume', () => {
    assert.equal(resumeLabelKey('2026-09-24', '2026-09-24'), 'timer.resume');
    assert.equal(resumeLabelKey('2026-09-23', '2026-09-24'), 'timer.startNew');
});

test('relativeDay says how long ago in words', () => {
    const today = '2026-09-24';
    assert.equal(relativeDay('2026-09-24', today, 'en'), 'today');
    assert.equal(relativeDay('2026-09-23', today, 'en'), 'yesterday');
    assert.equal(relativeDay('2026-09-21', today, 'en'), '3 days ago');
    assert.equal(relativeDay('2026-09-16', today, 'en'), 'last week');
    assert.equal(relativeDay('2026-09-10', today, 'en'), '2 weeks ago');
    assert.equal(relativeDay('2026-08-20', today, 'en'), 'last month');
    assert.equal(relativeDay('2026-07-01', today, 'en'), '2 months ago');
    assert.equal(relativeDay('2025-09-01', today, 'en'), 'last year');
});

test('relativeDay counts calendar days across a month end', () => {
    assert.equal(relativeDay('2026-09-30', '2026-10-01', 'en'), 'yesterday');
});

test('relativeDay speaks the app locale', () => {
    assert.equal(relativeDay('2026-09-23', '2026-09-24', 'fr'), 'hier');
});

test('splitAround cuts a sentence around the placeholder value', () => {
    assert.deepEqual(splitAround('Resume the old timer from ⁣ or start?', '⁣'), ['Resume the old timer from ', ' or start?']);
    assert.deepEqual(splitAround('no mark', '⁣'), ['no mark', '']);
});
