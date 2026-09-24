import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectOption } from '../src/api.ts';
import { clientOf, lastTimerWork, resumeLabelKey } from '../src/lastTimer.ts';

const project = (over: Partial<ProjectOption> = {}): ProjectOption => ({
    id: 'proj-1',
    name: 'Website',
    code: null,
    client: 'Acme',
    tasks: [],
    ...over,
});

test('the work line reads client – project · task', () => {
    assert.equal(lastTimerWork({ client: 'Acme', project: 'Website', task: 'Design' }), 'Acme – Website · Design');
    assert.equal(lastTimerWork({ client: 'Acme', project: 'Website', task: null }), 'Acme – Website');
});

test('a timer remembered before the client was stored shows the project alone', () => {
    assert.equal(lastTimerWork({ project: 'Website', task: 'Design' }), 'Website · Design');
    assert.equal(lastTimerWork({ client: null, project: 'Website', task: null }), 'Website');
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
