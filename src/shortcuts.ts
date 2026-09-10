// Global (system-wide) hotkeys: turning a keypress into an accelerator string,
// and an accelerator back into the symbols macOS writes it with.
//
// The stored form is a Tauri accelerator — "Control+Alt+Shift+Super+KeyS" —
// which is what Rust hands to the global-shortcut plugin. The key half is the
// KeyboardEvent's `code`, the *physical* key, so a binding stays on the same
// key whatever the layout prints on it; global-hotkey's parser takes those W3C
// names verbatim (see KEY_CODE / NAMED_KEYS, which mirror what it accepts —
// anything outside them would be refused at registration, so a recorder that
// only ever produces these can't store a binding the shell will reject).
//
// Kept out of App.vue (like idle.ts) because the mapping is fiddly enough to be
// worth testing on its own.

/** The three things a hotkey can do. Rust matches on these names. */
export type ShortcutAction = 'toggleTimer' | 'togglePopover' | 'toggleInsights';

/** Row order in the settings popover, and the order they are registered in. */
export const SHORTCUT_ACTIONS: ShortcutAction[] = ['toggleTimer', 'togglePopover', 'toggleInsights'];

/** One accelerator per action; '' is "not bound". */
export type Shortcuts = Record<ShortcutAction, string>;

export const noShortcuts = (): Shortcuts => ({ toggleTimer: '', togglePopover: '', toggleInsights: '' });

/**
 * Whatever came out of localStorage, made safe to render: unknown actions are
 * dropped and missing ones default to unbound, so a catalogue of actions that
 * grows (or an older build's prefs) can never leave a row undefined.
 */
export const readShortcuts = (stored: unknown): Shortcuts => {
    const shortcuts = noShortcuts();
    if (!stored || typeof stored !== 'object') return shortcuts;
    for (const action of SHORTCUT_ACTIONS) {
        const value = (stored as Record<string, unknown>)[action];
        if (typeof value === 'string') shortcuts[action] = value;
    }
    return shortcuts;
};

// Keys global-hotkey's parser understands, by shape: letters, digits, the
// function row and the numeric keypad.
const KEY_CODE = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Numpad[0-9])$/;

// …and the ones it names individually. CapsLock, NumLock, ScrollLock and
// Escape are left out on purpose: the first three are modes rather than keys,
// and Escape is how recording is cancelled.
const NAMED_KEYS = new Set([
    'Backquote',
    'Backslash',
    'BracketLeft',
    'BracketRight',
    'Comma',
    'Equal',
    'Minus',
    'Period',
    'Quote',
    'Semicolon',
    'Slash',
    'Backspace',
    'Delete',
    'End',
    'Enter',
    'Home',
    'Insert',
    'PageDown',
    'PageUp',
    'Space',
    'Tab',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'NumpadAdd',
    'NumpadDecimal',
    'NumpadDivide',
    'NumpadEnter',
    'NumpadEqual',
    'NumpadMultiply',
    'NumpadSubtract',
]);

/** Modifier order: the one macOS writes them in, ⌃⌥⇧⌘. */
const MODIFIER_SYMBOLS: [string, string][] = [
    ['Control', '⌃'],
    ['Alt', '⌥'],
    ['Shift', '⇧'],
    ['Super', '⌘'],
];

/** What each named key looks like on a macOS menu; the rest are their own name. */
const KEY_SYMBOLS: Record<string, string> = {
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    Backspace: '⌫',
    Delete: '⌦',
    End: '↘',
    Enter: '↩',
    Home: '↖',
    Insert: '⌅',
    PageDown: '⇟',
    PageUp: '⇞',
    Space: '␣',
    Tab: '⇥',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    NumpadAdd: '+',
    NumpadDecimal: '.',
    NumpadDivide: '/',
    NumpadEnter: '⌤',
    NumpadEqual: '=',
    NumpadMultiply: '*',
    NumpadSubtract: '−',
};

/**
 * The accelerator a keypress asks for, or null when it isn't one yet — a
 * modifier still on its own, an unsupported key, or a combination with no
 * modifier at all.
 *
 * Shift alone does not count as a modifier here: ⇧A is how a capital A is
 * typed, so binding it would swallow typing everywhere on the machine just as
 * a bare letter would. Command, Control or Option has to be in there.
 */
export const accelerator = (e: KeyboardEvent): string | null => {
    const key = e.code;
    if (!key || !(KEY_CODE.test(key) || NAMED_KEYS.has(key))) return null;
    if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
    const parts = MODIFIER_SYMBOLS.map(([name]) => name).filter(
        (name) =>
            (name === 'Control' && e.ctrlKey) || (name === 'Alt' && e.altKey) || (name === 'Shift' && e.shiftKey) || (name === 'Super' && e.metaKey),
    );
    return [...parts, key].join('+');
};

/** How macOS writes an accelerator: ⌃⌥⇧⌘ in that order, then the key. */
export const formatAccelerator = (accel: string): string => {
    if (!accel) return '';
    const parts = accel.split('+');
    const key = parts[parts.length - 1] ?? '';
    const modifiers = new Set(parts.slice(0, -1));
    const symbols = MODIFIER_SYMBOLS.filter(([name]) => modifiers.has(name))
        .map(([, symbol]) => symbol)
        .join('');
    return symbols + keyLabel(key);
};

const keyLabel = (key: string): string => {
    if (KEY_SYMBOLS[key]) return KEY_SYMBOLS[key];
    if (key.startsWith('Key')) return key.slice(3);
    if (key.startsWith('Digit')) return key.slice(5);
    if (key.startsWith('Numpad')) return key.slice(6);
    return key; // F1…F24, and anything a future parser learns
};

/**
 * `action` bound to `accel`. A combination can only mean one thing, so the new
 * binding wins and whichever row held it before is left unbound — the rule the
 * caller then has to carry over to the shell, freeing the old row first.
 */
export const assignShortcut = (shortcuts: Shortcuts, action: ShortcutAction, accel: string): Shortcuts => {
    const next = { ...shortcuts, [action]: accel };
    if (!accel) return next;
    for (const other of SHORTCUT_ACTIONS) {
        if (other !== action && next[other] === accel) next[other] = '';
    }
    return next;
};
