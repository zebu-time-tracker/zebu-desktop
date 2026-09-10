import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectOption } from '../src/api.ts';
import {
    defaultPresetName,
    filterPresets,
    hasPreset,
    newPresetId,
    presetRows,
    presetsFor,
    readPresets,
    removePreset,
    renamePreset,
    savePreset,
    type Preset,
} from '../src/presets.ts';

const preset = (over: Partial<Preset> = {}): Preset => ({
    id: 'p1',
    name: 'Website',
    project_id: 'proj-1',
    task_id: '',
    workspace: 'https://studio.zebu.work',
    ...over,
});

const project = (over: Partial<ProjectOption> = {}): ProjectOption => ({
    id: 'proj-1',
    name: 'Website',
    code: null,
    client: null,
    tasks: [],
    ...over,
});

// counting ids, so a test can say which row was added without guessing a uuid
const ids = () => {
    let n = 0;
    return () => `id-${++n}`;
};

test('stored presets are read back defensively', () => {
    assert.deepEqual(readPresets(undefined), []);
    assert.deepEqual(readPresets('[]'), []);
    assert.deepEqual(readPresets({ id: 'p1' }), []);
    // a row without an id, a name or a project cannot be rendered or started
    assert.deepEqual(readPresets([null, 7, {}, { id: 'p1' }, { id: 'p1', name: 'x' }, { name: 'x', project_id: 'a' }]), []);
    // missing fields become their empty value rather than undefined
    assert.deepEqual(readPresets([{ id: 'p1', name: ' Website ', project_id: 'proj-1' }]), [
        { id: 'p1', name: 'Website', project_id: 'proj-1', task_id: '', workspace: '' },
    ]);
});

test('a preset only counts on the workspace it was saved from, and the others are kept', () => {
    const all = [preset(), preset({ id: 'p2', workspace: 'https://other.zebu.work' })];

    assert.deepEqual(presetsFor(all, 'https://studio.zebu.work').map((p) => p.id), ['p1']);
    assert.deepEqual(presetsFor(all, 'https://other.zebu.work').map((p) => p.id), ['p2']);
    assert.deepEqual(presetsFor(all, 'https://nobody.zebu.work'), []);
    // filtering is a view, not a deletion: the stored list still holds both
    assert.equal(all.length, 2);
});

test('the same project and task is the same starting point, so saving it twice changes nothing', () => {
    const list = [preset()];
    const same = { name: 'Renamed by hand', project_id: 'proj-1', task_id: '', workspace: 'https://studio.zebu.work' };

    assert.equal(hasPreset(list, same), true);
    assert.equal(savePreset(list, same, ids()), list);

    // a different task, a different project or a different workspace is not the same thing
    for (const draft of [
        { ...same, task_id: 'task-1' },
        { ...same, project_id: 'proj-2' },
        { ...same, workspace: 'https://other.zebu.work' },
    ]) {
        assert.equal(hasPreset(list, draft), false);
        assert.equal(savePreset(list, draft, ids()).length, 2);
    }
});

test('saving appends a named preset and refuses a nameless or projectless one', () => {
    const saved = savePreset([], { name: '  Design  ', project_id: 'proj-9', task_id: 'task-3', workspace: 'w' }, ids());
    assert.deepEqual(saved, [{ id: 'id-1', name: 'Design', project_id: 'proj-9', task_id: 'task-3', workspace: 'w' }]);

    assert.deepEqual(savePreset([], { name: '   ', project_id: 'proj-9', task_id: '', workspace: 'w' }, ids()), []);
    assert.deepEqual(savePreset([], { name: 'Design', project_id: '', task_id: '', workspace: 'w' }, ids()), []);
});

test('renaming trims, and an empty name leaves the row as it was', () => {
    const list = [preset(), preset({ id: 'p2', name: 'Other' })];

    assert.deepEqual(renamePreset(list, 'p1', '  Client calls  ').map((p) => p.name), ['Client calls', 'Other']);
    assert.equal(renamePreset(list, 'p1', '   '), list);
    assert.deepEqual(renamePreset(list, 'nope', 'x'), list);
});

test('deleting takes only the row asked for', () => {
    const list = [preset(), preset({ id: 'p2' })];
    assert.deepEqual(removePreset(list, 'p1').map((p) => p.id), ['p2']);
    assert.deepEqual(removePreset(list, 'gone'), list);
});

test('ids are unique enough to key a list on', () => {
    assert.notEqual(newPresetId(), newPresetId());
    assert.ok(newPresetId().length > 8);
});

test('a fresh preset is named after its project, and its task when it has one', () => {
    const withTasks = project({ tasks: [{ id: 'task-1', name: 'Design' }] });
    assert.equal(defaultPresetName(withTasks, ''), 'Website');
    assert.equal(defaultPresetName(withTasks, 'task-1'), 'Website · Design');
    // a task that is no longer on the project just doesn't appear
    assert.equal(defaultPresetName(withTasks, 'task-gone'), 'Website');
    assert.equal(defaultPresetName(null, 'task-1'), '');
});

test('a row reads its client, code, project and task from the live project list', () => {
    const rows = presetRows(
        [preset({ task_id: 'task-1' })],
        [project({ code: 'ACME-1', client: 'Acme', tasks: [{ id: 'task-1', name: 'Design' }] })],
    );

    assert.equal(rows[0].subtitle, 'Acme · ACME-1: Website · Design');
    assert.equal(rows[0].missing, false);
    // the name is the user's and is never overwritten by what the project says now
    assert.equal(rows[0].preset.name, 'Website');
});

test('a preset whose project has gone is marked rather than silently started', () => {
    const rows = presetRows([preset()], [project({ id: 'somewhere-else' })]);
    assert.equal(rows[0].missing, true);
    assert.equal(rows[0].subtitle, '');
});

test('searching matches the name the user gave and what the row resolves to', () => {
    const rows = presetRows(
        [
            preset({ id: 'p1', name: 'Morning standup', project_id: 'proj-1' }),
            preset({ id: 'p2', name: 'Invoices', project_id: 'proj-2' }),
        ],
        [project({ id: 'proj-1', name: 'Website', client: 'Acme' }), project({ id: 'proj-2', name: 'Bookkeeping', client: 'Beta Co' })],
    );

    assert.deepEqual(filterPresets(rows, 'stand').map((r) => r.preset.id), ['p1']);
    // the client and project are searchable even though neither is in the name
    assert.deepEqual(filterPresets(rows, 'beta').map((r) => r.preset.id), ['p2']);
    assert.deepEqual(filterPresets(rows, 'website').map((r) => r.preset.id), ['p1']);
    assert.deepEqual(filterPresets(rows, 'nothing here'), []);
    // an empty search is not a filter
    assert.equal(filterPresets(rows, '  ').length, 2);
});
