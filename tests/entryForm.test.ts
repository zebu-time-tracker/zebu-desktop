import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDurationToSave, isApplePlatform, isSaveShortcut, saveShortcutHint, type KeyPress } from '../src/entryForm.ts';

const press = (key: string, mods: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({ key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods });

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
