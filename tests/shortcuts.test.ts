import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accelerator, assignShortcut, formatAccelerator, noShortcuts, readShortcuts, SHORTCUT_ACTIONS } from '../src/shortcuts.ts';

/** A keydown as the recorder sees it; only the fields accelerator() reads. */
const press = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
    ({ code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift }) as KeyboardEvent;

test('a keypress becomes an accelerator with its modifiers named in ⌃⌥⇧⌘ order', () => {
    assert.equal(accelerator(press('KeyS', { meta: true, shift: true })), 'Shift+Super+KeyS');
    assert.equal(accelerator(press('KeyT', { ctrl: true, alt: true })), 'Control+Alt+KeyT');
    // whatever order the flags are read in, the string is the same
    assert.equal(accelerator(press('Slash', { meta: true, ctrl: true, alt: true, shift: true })), 'Control+Alt+Shift+Super+Slash');
    assert.equal(accelerator(press('Digit1', { ctrl: true })), 'Control+Digit1');
    assert.equal(accelerator(press('F5', { alt: true })), 'Alt+F5');
    assert.equal(accelerator(press('ArrowUp', { meta: true })), 'Super+ArrowUp');
});

test('a combination without ⌘, ⌃ or ⌥ is not offered — it would swallow typing', () => {
    assert.equal(accelerator(press('KeyS')), null);
    // ⇧S is just how a capital S is typed, so Shift on its own is not enough
    assert.equal(accelerator(press('KeyS', { shift: true })), null);
    assert.equal(accelerator(press('F5')), null);
});

test('a modifier still held on its own keeps the recorder listening', () => {
    for (const code of ['MetaLeft', 'ShiftRight', 'ControlLeft', 'AltLeft']) {
        assert.equal(accelerator(press(code, { meta: true, shift: true })), null, code);
    }
});

test('keys the shell could not register are refused rather than stored', () => {
    // not in global-hotkey's parser: it would fail at registration time
    assert.equal(accelerator(press('IntlBackslash', { meta: true })), null);
    assert.equal(accelerator(press('ContextMenu', { ctrl: true })), null);
    assert.equal(accelerator(press('', { ctrl: true })), null);
    // deliberately left out: Escape cancels recording, the lock keys are modes
    assert.equal(accelerator(press('Escape', { meta: true })), null);
    assert.equal(accelerator(press('CapsLock', { meta: true })), null);
});

test('an accelerator is shown the way macOS writes it', () => {
    assert.equal(formatAccelerator('Shift+Super+KeyS'), '⇧⌘S');
    assert.equal(formatAccelerator('Control+Alt+KeyT'), '⌃⌥T');
    assert.equal(formatAccelerator('Control+Alt+Shift+Super+Slash'), '⌃⌥⇧⌘/');
    assert.equal(formatAccelerator('Super+Digit1'), '⌘1');
    assert.equal(formatAccelerator('Alt+F5'), '⌥F5');
    assert.equal(formatAccelerator('Super+ArrowUp'), '⌘↑');
    assert.equal(formatAccelerator('Control+Space'), '⌃␣');
    assert.equal(formatAccelerator('Super+Numpad7'), '⌘7');
    assert.equal(formatAccelerator(''), '');
});

test('the symbols keep their order however the accelerator was written', () => {
    // Rust does not care about token order, so the display must not either
    assert.equal(formatAccelerator('Super+Shift+KeyS'), '⇧⌘S');
    assert.equal(formatAccelerator('Shift+Super+KeyS'), '⇧⌘S');
});

test('what was recorded reads back as what is shown', () => {
    const recorded = accelerator(press('KeyZ', { meta: true, alt: true }));
    assert.equal(recorded, 'Alt+Super+KeyZ');
    assert.equal(formatAccelerator(recorded!), '⌥⌘Z');
});

test('every action the settings popover lists has a row of its own', () => {
    // the catalogue Rust matches on; a rename on either side stops a hotkey binding
    assert.deepEqual(SHORTCUT_ACTIONS, ['toggleTimer', 'newTimer', 'togglePopover', 'toggleInsights', 'showPresets']);
    assert.equal(new Set(SHORTCUT_ACTIONS).size, SHORTCUT_ACTIONS.length);
    assert.deepEqual(Object.keys(noShortcuts()), SHORTCUT_ACTIONS);
    assert.ok(Object.values(noShortcuts()).every((accel) => accel === ''));
});

test('a combination can only mean one thing: the newest binding wins', () => {
    const bound = { ...noShortcuts(), toggleTimer: 'Shift+Super+KeyS', togglePopover: 'Shift+Super+KeyZ' };
    assert.deepEqual(assignShortcut(bound, 'toggleInsights', 'Shift+Super+KeyS'), {
        ...noShortcuts(),
        togglePopover: 'Shift+Super+KeyZ',
        toggleInsights: 'Shift+Super+KeyS',
    });
    // the two rows added for presets play by the same rule
    assert.deepEqual(assignShortcut(bound, 'showPresets', 'Shift+Super+KeyZ'), {
        ...noShortcuts(),
        toggleTimer: 'Shift+Super+KeyS',
        showPresets: 'Shift+Super+KeyZ',
    });
    // re-recording the same combination on the row that already holds it is a no-op
    assert.deepEqual(assignShortcut(bound, 'toggleTimer', 'Shift+Super+KeyS'), bound);
    // clearing takes nothing else with it
    assert.deepEqual(assignShortcut(bound, 'toggleTimer', ''), { ...bound, toggleTimer: '' });
});

test('stored preferences are read back defensively', () => {
    assert.deepEqual(readShortcuts(undefined), noShortcuts());
    assert.deepEqual(readShortcuts('Super+KeyS'), noShortcuts());
    // an older build's prefs, plus an action this build no longer has
    assert.deepEqual(readShortcuts({ toggleTimer: 'Super+KeyS', toggleFavourite: 'Super+KeyF', togglePopover: 7 }), {
        ...noShortcuts(),
        toggleTimer: 'Super+KeyS',
    });
});
