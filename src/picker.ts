// Groups the project picker's already-ranked results by client, the way Harvest
// does it: the client is a small heading above its projects. Grouping never
// reshuffles what the fuzzy filter decided — a client's group sits at the
// position of its best-ranked project, and projects keep their rank order
// inside the group.
import type { ProjectOption } from './api';

export interface ProjectGroup {
    /** Client name, or '' for projects that have none. */
    client: string;
    projects: ProjectOption[];
    /** Index of the group's first project in the flattened list (keyboard nav). */
    offset: number;
}

export function groupByClient(projects: ProjectOption[]): ProjectGroup[] {
    const byClient = new Map<string, ProjectOption[]>();
    for (const p of projects) {
        const client = p.client ?? '';
        const group = byClient.get(client);
        if (group) group.push(p);
        else byClient.set(client, [p]);
    }

    let offset = 0;
    return [...byClient].map(([client, group]) => {
        const entry = { client, projects: group, offset };
        offset += group.length;
        return entry;
    });
}

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
