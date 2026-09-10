// What the popover should still be showing when it comes back.
//
// The menubar popover is hidden, never closed: the webview keeps running and
// everything laid over the timesheet — the new-entry sheet, an entry being
// edited, the settings popout — is still there the next time the window is
// shown. That is right for "I clicked another app for a second" and wrong for
// everything else: a sheet last touched ten minutes ago (or before an idle
// absence) comes back half-filled, over a timesheet that has been re-fetched
// several times since, and Save then writes from state nobody is looking at.
//
// So the rule is about *time away*, not about the sheet: under a minute the
// popover comes back exactly as it was, beyond that it comes back on the plain
// timesheet. Typed work is not thrown away for it — a touched new entry is
// stashed and the ＋ button hands it back — but an edit is never stashed: its
// values were read from a timesheet that has since moved on, and reopening the
// row is what re-reads them.
//
// Kept out of App.vue (like idle.ts and shortcuts.ts) so the rule is testable.

/** Under this, the popover only blinked: what was on screen is still what the user is doing. */
export const STALE_AFTER_MS = 60_000;

/** How long a stashed draft is worth offering back. */
export const DRAFT_TTL_MS = 60 * 60_000;

/** What the entry sheet was showing, if anything. */
export type SheetKind = 'none' | 'new' | 'edit';

export interface ReopenInput {
    /** How long the popover was hidden. `Infinity` for an idle absence, which is never a glance away. */
    awayMs: number;
    sheet: SheetKind;
    /** Whether anything was typed into the sheet that the server has not got. */
    dirty: boolean;
}

export interface ReopenPlan {
    /** Put the sheet and the other overlays away before the window is seen again. */
    clear: boolean;
    /** Keep the typed new entry, so the next ＋ picks it up instead of losing the work. */
    stash: boolean;
}

export const planReopen = ({ awayMs, sheet, dirty }: ReopenInput): ReopenPlan =>
    awayMs < STALE_AFTER_MS ? { clear: false, stash: false } : { clear: true, stash: sheet === 'new' && dirty };

/** The new-entry sheet's fields, as the form holds them. */
export interface EntryDraft {
    project_id: string;
    task_id: string;
    notes: string;
    duration: string;
    date: string;
}

export interface StashedDraft {
    draft: EntryDraft;
    /** When it was stashed (unix ms). */
    at: number;
}

/** Whether the user put anything of their own in, against what the sheet opened with. */
export const draftTouched = (draft: EntryDraft, prefill: EntryDraft): boolean =>
    (Object.keys(prefill) as (keyof EntryDraft)[]).some((key) => draft[key] !== prefill[key]);

/** The stashed draft if it is still worth offering back, otherwise null. */
export const takeDraft = (stashed: StashedDraft | null, now: number): EntryDraft | null =>
    stashed && now - stashed.at >= 0 && now - stashed.at < DRAFT_TTL_MS ? stashed.draft : null;
