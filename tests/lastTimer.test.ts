import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectOption } from '../src/api.ts';
import { clientOf, lastTimerProject, resumeLabelKey } from '../src/lastTimer.ts';

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
