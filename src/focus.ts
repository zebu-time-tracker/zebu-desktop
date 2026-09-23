// Focus tracking (board card #401): the rules behind the Focus tab.
//
// Rust records spans — which app, which window title, from when to when —
// into a local file (src-tauri/src/focus.rs) and nothing here ever sends them
// anywhere. This file turns a day's spans into what the tab shows: time per
// app, per site or document within an app, a timeline strip, and "Log 1:20
// to Website redesign?" suggestions matched against the user's own projects
// and recent entries. No Tauri, no fetch, so all of it runs under node --test.

export interface FocusSpan {
    app: string;
    title: string;
    /** unix ms */
    start: number;
    end: number;
}

/**
 * Apps that are never recorded unless the user takes them off the list:
 * password managers, whose window titles name the vault item on screen.
 */
export const DEFAULT_EXCLUDED = ['1Password', '1Password 7', 'Bitwarden', 'Dashlane', 'Enpass', 'KeePassXC', 'Keychain Access', 'LastPass', 'Passwords'];

/** The exclude list as typed in Settings — one per line or comma-separated — without blanks or repeats. */
export function parseExcludeList(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split(/[\n,]/)) {
        const name = raw.trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push(name);
    }
    return out;
}

// ---- grouping ---------------------------------------------------------------

const BROWSERS = ['safari', 'safari technology preview', 'google chrome', 'chrome', 'chromium', 'firefox', 'firefox developer edition', 'arc', 'microsoft edge', 'msedge', 'brave browser', 'brave', 'opera', 'vivaldi', 'orion', 'zen', 'zen browser', 'duckduckgo'];

export const isBrowser = (app: string) => BROWSERS.includes(app.trim().toLowerCase());

/** Title separators apps put between the page/document and the site/app name. */
const SEPARATOR = /\s+[-–—|·•]\s+/;

/** Pieces of a title that say nothing about the work: the app's own name, a terminal's size, a shell. */
const noise = (part: string, app: string) => {
    const p = part.toLowerCase();
    const a = app.toLowerCase();
    return (
        p === a ||
        (a.length > 3 && p.includes(a)) ||
        /^(google chrome|mozilla firefox|microsoft edge|brave|safari)$/.test(p) ||
        /^\d+\s*[×x]\s*\d+$/.test(p) ||
        /^-?(zsh|bash|fish|sh|login)$/.test(p)
    );
};

/** A title's meaningful pieces, in order, with unread counts and edit markers stripped. */
export function titleParts(app: string, title: string): string[] {
    const clean = title
        .replace(/^\(\d+\+?\)\s*/, '') // "(3) Inbox"
        .replace(/^[●•*]\s*/, '') // unsaved-changes dot
        .trim();
    const parts = clean
        .split(SEPARATOR)
        .map((p) => p.trim())
        .filter(Boolean);
    const meaningful = parts.filter((p) => !noise(p, app));
    // a title that is nothing but noise ("-zsh", "Figma Community") still
    // says something, unless it is only the app's own name
    if (!meaningful.length && parts.length && parts[0].toLowerCase() !== app.trim().toLowerCase()) return [parts[0]];
    return meaningful;
}

const DOMAIN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i;

/**
 * What a span is about within its app: for a browser the site (titles end
 * with it — "Pull request #12 · zebu-desktop · GitHub" is GitHub), for
 * anything else the last meaningful piece, which is where editors and chat
 * apps put the project or workspace ("lib.rs — zebu-desktop"). '' when the
 * title is empty or was not readable.
 */
export function groupKey(app: string, title: string): string {
    const parts = titleParts(app, title);
    if (!parts.length) return '';
    if (parts.length > 1) return parts[parts.length - 1];
    if (isBrowser(app)) {
        const domain = parts[0].match(DOMAIN);
        if (domain) return domain[1].replace(/^www\./, '').toLowerCase();
    }
    return parts[0];
}

export interface TitleTime {
    title: string;
    ms: number;
}
export interface FocusGroup {
    app: string;
    key: string;
    ms: number;
    /** longest first */
    titles: TitleTime[];
}
export interface FocusApp {
    app: string;
    ms: number;
    /** longest first */
    groups: FocusGroup[];
}

const clipped = (s: FocusSpan, from: number, to: number) => Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));

/** The spans between `from` and `to` (unix ms), by app and then by group, each longest first. */
export function groupSpans(spans: FocusSpan[], from = -Infinity, to = Infinity): FocusApp[] {
    const apps = new Map<string, { ms: number; groups: Map<string, { ms: number; titles: Map<string, number> }> }>();
    for (const s of spans) {
        const ms = clipped(s, from, to);
        if (ms <= 0) continue;
        const a = apps.get(s.app) ?? { ms: 0, groups: new Map() };
        apps.set(s.app, a);
        a.ms += ms;
        const key = groupKey(s.app, s.title);
        const g = a.groups.get(key) ?? { ms: 0, titles: new Map() };
        a.groups.set(key, g);
        g.ms += ms;
        if (s.title) g.titles.set(s.title, (g.titles.get(s.title) ?? 0) + ms);
    }
    const byMs = <T extends { ms: number }>(x: T, y: T) => y.ms - x.ms;
    return [...apps.entries()]
        .map(([app, a]) => ({
            app,
            ms: a.ms,
            groups: [...a.groups.entries()]
                .map(([key, g]) => ({ app, key, ms: g.ms, titles: [...g.titles.entries()].map(([title, ms]) => ({ title, ms })).sort(byMs) }))
                .sort(byMs),
        }))
        .sort(byMs);
}

export interface TimelineSegment {
    app: string;
    /** 0..1 of the strip */
    left: number;
    width: number;
}

/**
 * The strip under the totals: one segment per stretch of an app between
 * `from` and `to`, touching stretches of the same app merged so a morning
 * of tab-switching in one browser reads as one bar.
 */
export function timeline(spans: FocusSpan[], from: number, to: number): TimelineSegment[] {
    const range = to - from;
    if (range <= 0) return [];
    const sorted = spans.filter((s) => clipped(s, from, to) > 0).sort((a, b) => a.start - b.start);
    const merged: { app: string; start: number; end: number }[] = [];
    for (const s of sorted) {
        const start = Math.max(s.start, from);
        const end = Math.min(s.end, to);
        const last = merged[merged.length - 1];
        if (last && last.app === s.app && start - last.end <= 30_000) last.end = Math.max(last.end, end);
        else merged.push({ app: s.app, start, end });
    }
    return merged.map((m) => ({ app: m.app, left: (m.start - from) / range, width: (m.end - m.start) / range }));
}

/** The strip's window: from the hour the first span started to the hour after the last one ended. */
export function timelineRange(spans: FocusSpan[]): [number, number] | null {
    if (!spans.length) return null;
    const hour = 3_600_000;
    const first = Math.min(...spans.map((s) => s.start));
    const last = Math.max(...spans.map((s) => s.end));
    const from = new Date(first);
    from.setMinutes(0, 0, 0);
    const to = new Date(last);
    if (to.getMinutes() || to.getSeconds() || to.getMilliseconds()) {
        to.setMinutes(0, 0, 0);
        to.setTime(to.getTime() + hour);
    }
    return [from.getTime(), to.getTime()];
}

/** Local midnight to midnight of the day holding `at`. */
export function dayBounds(at: number): [number, number] {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    return [d.getTime(), next.getTime()];
}

// ---- suggestions ------------------------------------------------------------

const STOPWORDS = new Set(
    'the and for with from into your you our this that are was not but all new untitled home page inbox draft copy file edit view window tab tabs app www com http https html index main'.split(' '),
);

/** Lower-case, accent-free words of three letters or more, minus filler. */
export function words(text: string): string[] {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

export interface Candidate {
    project_id: string;
    task_id: string | null;
    /** what the suggestion names: "Website redesign" or "Website redesign · Design" */
    label: string;
    words: string[];
    /** how much a match on this counts: the running timer's project beats one from last week's notes */
    weight: number;
}

interface ProjectLike {
    id: string;
    name: string;
    code: string | null;
    client: string | null;
    tasks: { id: string; name: string }[];
}
interface EntryLike {
    project_id: string;
    task_id: string | null;
    notes: string | null;
}

/**
 * What a group can be matched to: every project (by its name, code and
 * client), every task, and the notes of recent entries (which is how "lib.rs
 * — zebu-desktop" finds a project called "Zebu" whose entries say
 * "zebu-desktop focus view"). The tracked timer's project and task count
 * double.
 */
export function candidatesFrom(projects: ProjectLike[], entries: EntryLike[], tracked: { project_id: string; task_id: string | null } | null): Candidate[] {
    const out: Candidate[] = [];
    const bonus = (pid: string, tid: string | null) => (tracked && tracked.project_id === pid && (tid === null || tracked.task_id === tid) ? 2 : 1);
    const byId = new Map(projects.map((p) => [p.id, p]));
    for (const p of projects) {
        const w = [...new Set(words([p.name, p.code ?? '', p.client ?? ''].join(' ')))];
        if (w.length) out.push({ project_id: p.id, task_id: null, label: p.name, words: w, weight: bonus(p.id, null) });
        for (const t of p.tasks) {
            const tw = [...new Set(words(t.name))].filter((x) => !w.includes(x));
            // a task is only told apart by its own words, and a generic one
            // ("Design") alone is weak evidence — it rides on its project's
            if (tw.length) out.push({ project_id: p.id, task_id: t.id, label: `${p.name} · ${t.name}`, words: [...w, ...tw], weight: bonus(p.id, t.id) * 0.9 });
        }
    }
    for (const e of entries) {
        const p = byId.get(e.project_id);
        if (!p || !e.notes) continue;
        const w = [...new Set(words(e.notes))];
        if (!w.length) continue;
        const task = e.task_id ? p.tasks.find((t) => t.id === e.task_id) : null;
        out.push({ project_id: p.id, task_id: task?.id ?? null, label: task ? `${p.name} · ${task.name}` : p.name, words: w, weight: bonus(p.id, task?.id ?? null) * 0.75 });
    }
    return out;
}

export interface Suggestion {
    project_id: string;
    task_id: string | null;
    label: string;
    minutes: number;
    notes: string;
}

/** Groups shorter than this are not worth an entry of their own. */
export const MIN_SUGGEST_MINUTES = 5;

/**
 * The best candidate for a group, or null. A candidate matches when at least
 * half its words (and at least one) appear in the group's titles; among
 * matches, more matched words and a higher weight win.
 */
export function suggestFor(group: FocusGroup, candidates: Candidate[]): Suggestion | null {
    const minutes = Math.floor(group.ms / 60_000);
    if (minutes < MIN_SUGGEST_MINUTES) return null;
    const have = new Set(words([group.key, ...group.titles.map((t) => t.title)].join(' ')));
    if (!have.size) return null;
    let best: { c: Candidate; score: number } | null = null;
    for (const c of candidates) {
        const hits = c.words.filter((w) => have.has(w)).length;
        if (!hits || hits * 2 < c.words.length) continue;
        const score = hits * c.weight;
        if (!best || score > best.score) best = { c, score };
    }
    if (!best) return null;
    return { project_id: best.c.project_id, task_id: best.c.task_id, label: best.c.label, minutes, notes: summariseTitles(group) };
}

/**
 * The notes a suggested entry is prefilled with: the group's longest titles,
 * without the site or app name every one of them repeats, joined up to a
 * sensible length. The user edits it before anything is saved.
 */
export function summariseTitles(group: FocusGroup, max = 3, limit = 200): string {
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const { title } of group.titles) {
        const parts = titleParts(group.app, title).filter((p) => p !== group.key);
        const text = (parts.length ? parts : [title]).join(' · ');
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        picked.push(text);
        if (picked.length === max) break;
    }
    let notes = picked.join('; ');
    if (!notes) notes = group.key;
    return notes.length > limit ? `${notes.slice(0, limit - 1).trimEnd()}…` : notes;
}
