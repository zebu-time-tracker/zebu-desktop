import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    accelerator,
    assignShortcut,
    defaultShortcuts,
    defaultsToApply,
    formatAccelerator,
    noShortcuts,
    offerChanges,
    readShortcuts,
    shortcutOffer,
    SHORTCUT_ACTIONS,
} from '../src/shortcuts.ts';

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

// The bindings a Mac is offered on first run (board #569).
test('a Mac is offered the timer, a new timer and the popover, on Harvest\'s keys; other platforms nothing', () => {
    const mac = defaultShortcuts(true);
    assert.deepEqual(mac, { toggleTimer: 'Alt+Super+KeyP', newTimer: 'Alt+Super+KeyN', togglePopover: 'Alt+Super+KeyT' });
    assert.deepEqual(Object.values(mac).map(formatAccelerator), ['⌥⌘P', '⌥⌘N', '⌥⌘T']);
    assert.deepEqual(defaultShortcuts(false), {});
});

test('every default is a combination the recorder itself could have produced, and no two are the same', () => {
    const accels = Object.values(defaultShortcuts(true));
    for (const accel of accels) {
        const keys = accel.split('+');
        const event = press(keys[keys.length - 1], { ctrl: keys.includes('Control'), alt: keys.includes('Alt'), shift: keys.includes('Shift'), meta: keys.includes('Super') });
        assert.equal(accelerator(event), accel);
    }
    assert.equal(new Set(accels).size, accels.length);
});

test('with nothing bound, every default is on the card, in row order', () => {
    const offer = shortcutOffer(noShortcuts(), defaultShortcuts(true));
    assert.deepEqual(offer?.actions, ['toggleTimer', 'newTimer', 'togglePopover']);
    assert.deepEqual(offer?.draft, { ...noShortcuts(), toggleTimer: 'Alt+Super+KeyP', newTimer: 'Alt+Super+KeyN', togglePopover: 'Alt+Super+KeyT' });
});

test('a row the person bound shows their binding, and only the untouched rows are filled', () => {
    const mine = { ...noShortcuts(), toggleTimer: 'Control+Alt+KeyS' };
    const offer = shortcutOffer(mine, defaultShortcuts(true));
    assert.equal(offer?.draft.toggleTimer, 'Control+Alt+KeyS');
    assert.equal(offer?.draft.newTimer, 'Alt+Super+KeyN');
    assert.deepEqual(
        defaultsToApply(mine, defaultShortcuts(true)).map(([action]) => action),
        ['newTimer', 'togglePopover'],
    );
});

test('a default combination the person gave to another row is not taken from it', () => {
    // ⌥⌘P already shows Insights here: the timer row is offered empty rather than stealing it
    const mine = { ...noShortcuts(), toggleInsights: 'Alt+Super+KeyP' };
    const offer = shortcutOffer(mine, defaultShortcuts(true));
    assert.equal(offer?.draft.toggleTimer, '');
    assert.equal(offer?.draft.toggleInsights, 'Alt+Super+KeyP');
});

test('nothing to offer means no card: no defaults here, or every row already bound', () => {
    assert.equal(shortcutOffer(noShortcuts(), defaultShortcuts(false)), null);
    const all = { ...noShortcuts(), toggleTimer: 'Alt+KeyA', newTimer: 'Alt+KeyB', togglePopover: 'Alt+KeyC' };
    assert.equal(shortcutOffer(all, defaultShortcuts(true)), null);
});

test('"Turn on" binds only the rows where the card differs from what is live', () => {
    const live = { ...noShortcuts(), toggleInsights: 'Alt+Super+KeyI' };
    const offer = shortcutOffer(live, defaultShortcuts(true))!;
    assert.deepEqual(offerChanges(live, offer.draft), [
        ['toggleTimer', 'Alt+Super+KeyP'],
        ['newTimer', 'Alt+Super+KeyN'],
        ['togglePopover', 'Alt+Super+KeyT'],
    ]);
    // a row emptied on the card is simply not bound; one re-recorded there is bound as recorded
    const edited = assignShortcut({ ...offer.draft, togglePopover: '' }, 'toggleTimer', 'Control+Alt+Super+KeyS');
    assert.deepEqual(offerChanges(live, edited), [
        ['toggleTimer', 'Control+Alt+Super+KeyS'],
        ['newTimer', 'Alt+Super+KeyN'],
    ]);
    assert.deepEqual(offerChanges(live, live), []);
});
