// The rules behind the entry sheet's search pickers (SearchSelect.vue): the
// project picker and, since board #501, the task picker are the same
// component, so they share every rule here. Kept out of the component so they
// are testable without a webview.

export interface Group<T> {
    /** What the rows have in common, e.g. the client's name; '' for "none". */
    key: string;
    items: T[];
    /** Index of the group's first row in the flattened list (keyboard nav). */
    offset: number;
}

/**
 * Groups already-ranked results under a heading each, the way Harvest groups
 * projects by client. Grouping never reshuffles what the fuzzy filter decided
 * — a group sits at the position of its best-ranked item, and items keep their
 * rank order inside it. `start` is the index of the first grouped row, for a
 * list that has a row above the groups.
 */
export function groupBy<T>(items: T[], keyOf: (item: T) => string, start = 0): Group<T>[] {
    const byKey = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const group = byKey.get(key);
        if (group) group.push(item);
        else byKey.set(key, [item]);
    }

    let offset = start;
    return [...byKey].map(([key, group]) => {
        const entry = { key, items: group, offset };
        offset += group.length;
        return entry;
    });
}

// ---- the highlighted row ---------------------------------------------------
//
// The highlight is the row Return picks, so only the person may move it: the
// arrow keys, the pointer actually moving, or the query they type. Board #501:
// it used to be an index reset to the top whenever the list changed, and the
// list changes on its own — every timesheet refetch (opening the popover,
// the five-minute backstop, a push) hands over a fresh project array — so a
// refetch landing between ↓ and Return sent Return to the first row, which on
// a new sheet is the project already filled in. And a list scrolled by ↓
// under a resting pointer reported that pointer as "entering" a new row, which
// moved the highlight to wherever the pointer happened to be.

/** What a key does to an open list; null leaves the key to the input. */
export type ListKey = 'next' | 'prev' | 'pick' | 'close';

export type ListKeyPress = Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>;

export const listKey = (e: ListKeyPress): ListKey | null => {
    // An input method is composing: its Return confirms the characters and its
    // arrows walk its own candidates (WebKit reports such keys as keyCode 229).
    if (e.isComposing || e.keyCode === 229) return null;
    if (e.key === 'ArrowDown') return 'next';
    if (e.key === 'ArrowUp') return 'prev';
    if (e.key === 'Enter') return 'pick';
    if (e.key === 'Escape') return 'close';
    return null;
};

/** One row up or down, stopping at the ends; -1 when there are no rows. */
export const step = (index: number, delta: 1 | -1, count: number): number => {
    if (count <= 0) return -1;
    if (index < 0) return 0;
    return Math.min(Math.max(index + delta, 0), count - 1);
};

/** Where the highlight starts: on the current choice when it is listed, else the top. */
export const homeIndex = (ids: string[], selected: string): number => (ids.length ? Math.max(ids.indexOf(selected), 0) : -1);

export interface ListChange {
    /** The rows now, by id, top to bottom. */
    ids: string[];
    /** The rows before this change. */
    prevIds: string[];
    /** The highlight before this change, an index into `prevIds`. */
    index: number;
    /** Whether the person changed the query (rather than the list changing under them). */
    queryChanged: boolean;
    query: string;
    /** The id currently chosen. */
    selected: string;
}

/** Where the highlight goes when the rows change. */
export function settleActive({ ids, prevIds, index, queryChanged, query, selected }: ListChange): number {
    if (!ids.length) return -1;
    // a new query ranks the rows afresh: the best match is the one to pick
    if (queryChanged) return query.trim() ? 0 : homeIndex(ids, selected);
    // the same query over a refreshed list: stay on the row that was highlighted
    const id = prevIds[index];
    const kept = id === undefined ? -1 : ids.indexOf(id);
    if (kept >= 0) return kept;
    return Math.min(Math.max(index, 0), ids.length - 1);
}

/**
 * Whether a mousemove is the pointer moving. Scrolling the list under a still
 * pointer makes the browser report the pointer over a new row; only a move
 * that changed its screen position is the person pointing at something.
 */
export const pointerMoved = (last: { x: number; y: number } | null, now: { x: number; y: number }): boolean => !last || last.x !== now.x || last.y !== now.y;

/**
 * Has focus actually left the picker?
 *
 * The open list closes when focus leaves it, and the obvious way to ask —
 * whether the focusout event's `relatedTarget` is still inside — gets the most
 * common case wrong. Clicking the trigger focuses it on any platform that
 * focuses buttons on click; opening the list then swaps that button out for the
 * search input, and an element removed while focused reports a `relatedTarget`
 * of null, which is indistinguishable from "focus left the picker". So the list
 * opened and shut again in the same click (board #136).
 *
 * The answer is taken from where focus actually ended up instead, read a frame
 * after the event rather than from the event itself. macOS's webview does not
 * focus buttons on click, which is why the shipped app never showed this and a
 * Chromium harness does.
 */
export function focusLeftPicker(root: Node | null | undefined, active: Node | null | undefined): boolean {
    if (!root) return false;

    return !active || !root.contains(active);
}
