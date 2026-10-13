import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDurationToSave, isApplePlatform, isNewEntryShortcut, isSaveShortcut, newEntryShortcutHint, newEntryShortcutKeys, saveShortcutHint, saveShortcutKeys, taskForProject, newTimerPrefill, type KeyPress } from '../src/entryForm.ts';

const press = (key: string, mods: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods });

test('a running timer at 0:00 saves its notes without sending a duration (board #398)', () => {
    assert.deepEqual(editDurationToSave({ typed: '0:00', opened: '0:00', running: true }), { ok: true, minutes: null });
    // cleared, it still leaves the clock alone
    assert.deepEqual(editDurationToSave({ typed: '', opened: '0:12', running: true }), { ok: true, minutes: null });
});

test('a duration typed into a running timer is sent, zero included, and nonsense is refused', () => {
    assert.deepEqual(editDurationToSave({ typed: '1:30', opened: '0:00', running: true }), { ok: true, minutes: 90 });
    assert.deepEqual(editDurationToSave({ typed: '0', opened: '0:20', running: true }), { ok: true, minutes: 0 });
    assert.deepEqual(editDurationToSave({ typed: 'soon', opened: '0:00', running: true }), { ok: false });
});

test('a stopped entry is refused a duration of nothing', () => {
    assert.deepEqual(editDurationToSave({ typed: '0:00', opened: '1:00', running: false }), { ok: false });
    assert.deepEqual(editDurationToSave({ typed: '0:00', opened: '0:00', running: false }), { ok: false });
    assert.deepEqual(editDurationToSave({ typed: 'abc', opened: '1:00', running: false }), { ok: false });
});

test('a stopped entry sends only a changed duration', () => {
    assert.deepEqual(editDurationToSave({ typed: '1:00', opened: '1:00', running: false }), { ok: true, minutes: null });
    assert.deepEqual(editDurationToSave({ typed: '1:15', opened: '1:00', running: false }), { ok: true, minutes: 75 });
    assert.deepEqual(editDurationToSave({ typed: '', opened: '1:00', running: false }), { ok: true, minutes: null });
});

test('⌘↵ saves on a Mac and Ctrl+↵ elsewhere; a plain Enter is a newline', () => {
    assert.equal(isSaveShortcut(press('Enter', { metaKey: true }), true), true);
    assert.equal(isSaveShortcut(press('Enter', { ctrlKey: true }), false), true);
    assert.equal(isSaveShortcut(press('Enter'), true), false);
    assert.equal(isSaveShortcut(press('Enter'), false), false);
    // the other platform's modifier is not it
    assert.equal(isSaveShortcut(press('Enter', { ctrlKey: true }), true), false);
    assert.equal(isSaveShortcut(press('Enter', { metaKey: true }), false), false);
    assert.equal(isSaveShortcut(press('Enter', { metaKey: true, altKey: true }), true), false);
    assert.equal(isSaveShortcut(press('s', { metaKey: true }), true), false);
    // Enter confirming an input method's candidate is not a save
    assert.equal(isSaveShortcut(press('Enter', { metaKey: true, isComposing: true }), true), false);
});

test('the hint follows the platform and the locale', () => {
    assert.equal(isApplePlatform('MacIntel'), true);
    assert.equal(isApplePlatform('macOS'), true);
    assert.equal(isApplePlatform('Win32'), false);
    assert.equal(isApplePlatform('Linux x86_64'), false);
    assert.equal(saveShortcutHint(true, 'Ctrl'), '⌘↵');
    assert.equal(saveShortcutHint(false, 'Strg'), 'Strg+↵');
});

test('⌘N on a Mac and Ctrl+N elsewhere open a new entry, nothing else does (board #449)', () => {
    assert.equal(isNewEntryShortcut(press('n', { metaKey: true }), true), true);
    assert.equal(isNewEntryShortcut(press('N', { metaKey: true }), true), true);
    assert.equal(isNewEntryShortcut(press('n', { ctrlKey: true }), false), true);
    // the other platform's modifier, extra modifiers, or none
    assert.equal(isNewEntryShortcut(press('n', { ctrlKey: true }), true), false);
    assert.equal(isNewEntryShortcut(press('n', { metaKey: true }), false), false);
    assert.equal(isNewEntryShortcut(press('n', { metaKey: true, shiftKey: true }), true), false);
    assert.equal(isNewEntryShortcut(press('n', { metaKey: true, altKey: true }), true), false);
    assert.equal(isNewEntryShortcut(press('n'), true), false);
    assert.equal(isNewEntryShortcut(press('n', { metaKey: true, isComposing: true }), true), false);
    assert.equal(newEntryShortcutHint(true, 'Ctrl'), '⌘N');
    assert.equal(newEntryShortcutHint(false, 'Strg'), 'Strg+N');
});

test('a new project keeps the task only when it has that task', () => {
    const tasks = [{ id: 't1' }, { id: 't2' }];

    assert.equal(taskForProject(tasks, 't2'), 't2');
    assert.equal(taskForProject(tasks, 't9'), '');
    assert.equal(taskForProject([], 't1'), '');
    assert.equal(taskForProject(tasks, ''), '');
});

test('the shortcuts as one keycap per key (board #517)', () => {
    assert.deepEqual(saveShortcutKeys(true, 'Ctrl'), ['⌘', '↵']);
    assert.deepEqual(saveShortcutKeys(false, 'Strg'), ['Strg', '↵']);
    assert.deepEqual(newEntryShortcutKeys(true, 'Ctrl'), ['⌘', 'N']);
    assert.deepEqual(newEntryShortcutKeys(false, 'Strg'), ['Strg', 'N']);
});

test('a new timer copies the last timer\'s project and task (board #522)', () => {
    const projects = [
        { id: 'p1', tasks: [{ id: 't1' }] },
        { id: 'p2', tasks: [{ id: 't2' }, { id: 't3' }] },
    ];
    assert.deepEqual(newTimerPrefill(projects, { project_id: 'p2', task_id: 't3' }), { project_id: 'p2', task_id: 't3' });
    // no task on the last timer, or one the project no longer has: project only
    assert.deepEqual(newTimerPrefill(projects, { project_id: 'p2', task_id: null }), { project_id: 'p2', task_id: '' });
    assert.deepEqual(newTimerPrefill(projects, { project_id: 'p2', task_id: 'gone' }), { project_id: 'p2', task_id: '' });
    // no last timer, or its project is gone: the first project, as before
    assert.deepEqual(newTimerPrefill(projects, null), { project_id: 'p1', task_id: '' });
    assert.deepEqual(newTimerPrefill(projects, { project_id: 'gone', task_id: 't1' }), { project_id: 'p1', task_id: '' });
    assert.deepEqual(newTimerPrefill([], null), { project_id: '', task_id: '' });
});
