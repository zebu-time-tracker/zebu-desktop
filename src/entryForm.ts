// The entry sheet's two rules worth testing on their own (board #398): what
// an edit's duration field asks the server for, and which keypress saves the
// sheet. The browser extension's src/entryForm.ts follows the same rules.
//
// Kept out of App.vue (like popover.ts and shortcuts.ts) so they are testable.

import { parseDuration } from './duration.ts';

export interface EditDurationInput {
    /** What the duration field holds now. */
    typed: string;
    /** What it was prefilled with when the sheet opened. */
    opened: string;
    /** Whether the entry's clock is running. */
    running: boolean;
}

/** `minutes: null` leaves the entry's duration alone; `ok: false` refuses the save. */
export type DurationResult = { ok: true; minutes: number | null } | { ok: false };

export const editDurationToSave = ({ typed, opened, running }: EditDurationInput): DurationResult => {
    const value = typed.trim();
    const minutes = value ? parseDuration(value) : null;

    // A running timer's field shows its clock, not a duration to check: one
    // started seconds ago reads 0:00, and saving its notes must neither be
    // refused for that nor send it back (which would rebase the clock). Only a
    // duration the person typed is sent, and then 0 is a fair answer: the
    // server restarts the clock from zero.
    if (running) {
        if (!value || value === opened.trim()) return { ok: true, minutes: null };
        return minutes === null ? { ok: false } : { ok: true, minutes };
    }

    // A finished entry needs a real duration, and only a changed one is sent.
    if (value && (minutes === null || minutes <= 0)) return { ok: false };
    return { ok: true, minutes: value === opened.trim() ? null : minutes };
};

/** The keys of a keydown that the save shortcut reads. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>;

/** Whether the platform string (navigator.platform and the like) is Apple's, where ⌘ is the command key. */
export const isApplePlatform = (platform: string): boolean => /mac|iphone|ipad|ipod/i.test(platform);

/**
 * ⌘↵ on a Mac, Ctrl+↵ elsewhere, saves the sheet from any of its fields. A
 * plain Enter is left alone, so the notes still take a newline, and so is an
 * Enter that confirms an input method's composition.
 */
export const isSaveShortcut = (e: KeyPress, apple: boolean): boolean =>
    e.key === 'Enter' && !e.isComposing && !e.altKey && (apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** The keycap shown in the save button; `ctrl` is the locale's name for the Control key. */
export const saveShortcutHint = (apple: boolean, ctrl: string): string => (apple ? '⌘↵' : `${ctrl}+↵`);
