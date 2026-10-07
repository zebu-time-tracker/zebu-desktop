// Focus tracking (board card #401): the rules behind the Focus tab.
//
// Rust records spans — which app, which window title, from when to when —
// into a local file (src-tauri/src/focus.rs) and nothing here ever sends them
// anywhere. This file turns a day's spans into what the tab shows: time per
// app, per site or document within an app, a timeline strip, and "Log 1:20
// to Website redesign?" suggestions matched against the user's own projects
// and recent entries, plus the By project view (board #512): every title
// filed under the project it most likely belongs to, with what is left to log.
// No Tauri, no fetch, so all of it runs under node --test.

import type { RuleIndex } from './focusRules.ts';

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

/**
 * The finer place a span is filed under in the By project view, and what a
 * rule made there names. The same as groupKey, except that a browser title of
 * three pieces or more keeps the piece before the site: "Pull request #12 ·
 * acme/website · GitHub" is "acme/website · GitHub", one repository rather
 * than all of GitHub, so two repositories can belong to two projects.
 */
export function placeKey(app: string, title: string): string {
    const parts = titleParts(app, title);
    if (isBrowser(app) && parts.length >= 3) return `${parts[parts.length - 2]} · ${parts[parts.length - 1]}`;
    return groupKey(app, title);
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
    /** words that add to a match's hits without being needed for one (the client's) */
    extra?: string[];
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
        const w = [...new Set(words([p.name, p.code ?? ''].join(' ')))];
        // the client backs a match up but cannot make one: "Acme Corp" names
        // every project Acme has, and its words must not water down the name's
        const cw = [...new Set(words(p.client ?? ''))].filter((x) => !w.includes(x));
        if (w.length) out.push({ project_id: p.id, task_id: null, label: p.name, words: w, extra: cw, weight: bonus(p.id, null) });
        for (const t of p.tasks) {
            const tw = [...new Set(words(t.name))].filter((x) => !w.includes(x));
            // a task is only told apart by its own words, and a generic one
            // ("Design") alone is weak evidence — it rides on its project's
            if (tw.length) out.push({ project_id: p.id, task_id: t.id, label: `${p.name} · ${t.name}`, words: [...w, ...tw], extra: cw, weight: bonus(p.id, t.id) * 0.9 });
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
    const best = bestCandidate([group.key, ...group.titles.map((t) => t.title)].join(' '), candidates);
    if (!best) return null;
    return { project_id: best.project_id, task_id: best.task_id, label: best.label, minutes, notes: summariseTitles(group) };
}

/**
 * The candidate `text` names best. A candidate matches when one of its own
 * words is there and its hits (client words included) come to at least half
 * its own words; among matches, most hits times weight wins.
 */
export function bestCandidate(text: string, candidates: Candidate[]): Candidate | null {
    // an address names whose inbox it is, not what the work is about
    const have = new Set(words(text.replace(/\S+@\S+/g, ' ')));
    if (!have.size) return null;
    let best: { c: Candidate; score: number } | null = null;
    for (const c of candidates) {
        const own = c.words.filter((w) => have.has(w)).length;
        if (!own) continue;
        const hits = own + (c.extra?.filter((w) => have.has(w)).length ?? 0);
        if (hits * 2 < c.words.length) continue;
        const score = hits * c.weight;
        if (!best || score > best.score) best = { c, score };
    }
    return best?.c ?? null;
}

/**
 * The notes a suggested entry is prefilled with: the group's longest titles,
 * without the site or app name every one of them repeats, joined up to a
 * sensible length. The user edits it before anything is saved.
 */
export function summariseTitles(group: FocusGroup, max = 3, limit = 200): string {
    return joinNotes(
        group.titles.map(({ title }) => titleNote(group.app, title, [group.key])),
        group.key,
        max,
        limit,
    );
}

/** A title as a line of notes: its meaningful pieces, minus the place it is filed under. */
const titleNote = (app: string, title: string, drop: string[]) => {
    const parts = titleParts(app, title).filter((p) => !drop.includes(p));
    return (parts.length ? parts : [title]).join(' · ');
};

/** Up to `max` distinct lines joined with "; ", cut at `limit` characters; `fallback` when there are none. */
const joinNotes = (lines: string[], fallback: string, max: number, limit: number) => {
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const text of lines) {
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        picked.push(text);
        if (picked.length === max) break;
    }
    const notes = picked.join('; ') || fallback;
    return notes.length > limit ? `${notes.slice(0, limit - 1).trimEnd()}…` : notes;
};

// ---- by project (board #512) ------------------------------------------------

/** One window title's time today, and the project it was filed under. */
export interface Assigned {
    app: string;
    title: string;
    /** the By app row it sits in */
    group: string;
    /** the By project row it sits in, and what a rule made there names */
    place: string;
    ms: number;
    project_id: string | null;
    task_id: string | null;
}

/**
 * Every title between `from` and `to`, filed under a project. Titles rather
 * than whole groups, so one browser's GitHub can be two repositories for two
 * projects. In order, first answer wins:
 *
 * 1. a rule for exactly this place, then one for the whole app — the user
 *    said so, and what they said beats any guess;
 * 2. the title naming a project, a task or a recent entry's notes;
 * 3. in a browser, a rule for the wider site (a By app row: all of GitHub)
 *    or for the whole browser. A site holds unrelated pages, so there a
 *    page that names a project goes to it, and the rule fills in the rest.
 *
 * Anything else is unassigned (project_id null).
 */
export function assignTitles(spans: FocusSpan[], from: number, to: number, candidates: Candidate[], rule: RuleIndex): Assigned[] {
    const titles = new Map<string, { app: string; title: string; ms: number }>();
    for (const s of spans) {
        const ms = clipped(s, from, to);
        if (ms <= 0) continue;
        const id = `${s.app}\n${s.title}`;
        const t = titles.get(id) ?? { app: s.app, title: s.title, ms: 0 };
        titles.set(id, t);
        t.ms += ms;
    }
    return [...titles.values()].map(({ app, title, ms }) => {
        const group = groupKey(app, title);
        const place = placeKey(app, title);
        const match = place ? bestCandidate(`${place} ${title}`, candidates) : null;
        const exact = rule(app, place);
        const wider = exact ? null : ((group !== place ? rule(app, group) : null) ?? (place ? rule(app, '') : null));
        // a rule wins over a guess, except one about all of a browser or all
        // of a site in one: those hold unrelated pages, so a page naming a
        // project of its own goes there
        const ruled = exact ?? (wider && !isBrowser(app) ? wider : null);
        let project_id: string | null = null;
        let task_id: string | null = null;
        if (ruled) {
            project_id = ruled;
            // the rule names the project; a title that also names one of its tasks keeps the task
            if (match?.project_id === ruled) task_id = match.task_id;
        } else if (match) {
            project_id = match.project_id;
            task_id = match.task_id;
        } else {
            project_id = wider;
        }
        return { app, title, group, place, ms, project_id, task_id };
    });
}

export interface Place {
    app: string;
    /** placeKey; '' for an app whose titles were not readable */
    key: string;
    ms: number;
    /** longest first */
    titles: TitleTime[];
}
export interface ProjectGroup {
    /** null: the Unassigned group */
    project_id: string | null;
    /** the task most of the time was matched to, if any */
    task_id: string | null;
    ms: number;
    /** longest first */
    places: Place[];
}

/** The By project view: projects longest first, then Unassigned. */
export function byProject(assigned: Assigned[]): ProjectGroup[] {
    const groups = new Map<string | null, { ms: number; tasks: Map<string | null, number>; places: Map<string, Place> }>();
    for (const a of assigned) {
        const g = groups.get(a.project_id) ?? { ms: 0, tasks: new Map(), places: new Map() };
        groups.set(a.project_id, g);
        g.ms += a.ms;
        g.tasks.set(a.task_id, (g.tasks.get(a.task_id) ?? 0) + a.ms);
        const id = `${a.app}\n${a.place}`;
        const p = g.places.get(id) ?? { app: a.app, key: a.place, ms: 0, titles: [] };
        g.places.set(id, p);
        p.ms += a.ms;
        if (a.title) p.titles.push({ title: a.title, ms: a.ms });
    }
    const byMs = <T extends { ms: number }>(x: T, y: T) => y.ms - x.ms;
    const out: ProjectGroup[] = [...groups.entries()].map(([project_id, g]) => {
        let task_id: string | null = null;
        let most = -1;
        for (const [id, ms] of g.tasks) {
            if (ms > most || (ms === most && task_id === null)) {
                task_id = id;
                most = ms;
            }
        }
        const places = [...g.places.values()].sort(byMs);
        for (const p of places) p.titles.sort(byMs);
        return { project_id, task_id: project_id ? task_id : null, ms: g.ms, places };
    });
    return out.sort((x, y) => (x.project_id === null ? 1 : 0) - (y.project_id === null ? 1 : 0) || byMs(x, y));
}

/**
 * The project a By app row counts toward, for its tag: the one most of its
 * time went to, or null when most of it went nowhere. `group` undefined asks
 * about the whole app.
 */
export function projectOfRow(assigned: Assigned[], app: string, group?: string): string | null {
    const ms = new Map<string | null, number>();
    for (const a of assigned) if (a.app === app && (group === undefined || a.group === group)) ms.set(a.project_id, (ms.get(a.project_id) ?? 0) + a.ms);
    let best: string | null = null;
    let most = 0;
    for (const [id, m] of ms) {
        if (m > most) {
            best = id;
            most = m;
        }
    }
    return best;
}

/** Minutes already on the clock today, per project — a running timer counted up to `now`. */
export function trackedToday(entries: { project_id: string; date: string; minutes: number; timer_started_at: string | null }[], today: string, now: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of entries) {
        if (e.date !== today) continue;
        const m = e.timer_started_at ? e.minutes + Math.max(0, (now - new Date(e.timer_started_at).getTime()) / 60_000) : e.minutes;
        out.set(e.project_id, (out.get(e.project_id) ?? 0) + m);
    }
    return out;
}

export interface LogState {
    /** whole minutes of focus on the project today */
    focused: number;
    /** what is left to log once today's entries on the project are taken off */
    minutes: number;
    /** log: worth an entry; logged: today's entries already cover it; none: too little to bother */
    state: 'log' | 'logged' | 'none';
}

/**
 * What a project group offers to log. Time already tracked on the project
 * today comes off first, so logging a group (or having had a timer running
 * on it) leaves nothing to log twice.
 */
export function logState(ms: number, trackedMinutes: number): LogState {
    const focused = Math.floor(ms / 60_000);
    const minutes = Math.max(0, focused - Math.floor(trackedMinutes));
    const state = minutes >= MIN_SUGGEST_MINUTES ? 'log' : trackedMinutes > 0 ? 'logged' : 'none';
    return { focused, minutes, state };
}

/** A project group's entry notes: its longest titles, each without the place it is filed under. */
export function notesFor(group: ProjectGroup, max = 3, limit = 200): string {
    const titles = group.places
        .flatMap((p) => p.titles.map((t) => ({ ...t, app: p.app, drop: [p.key, ...p.key.split(' · '), groupKey(p.app, t.title)] })))
        .sort((x, y) => y.ms - x.ms);
    const fallback = group.places.map((p) => p.key || p.app).join(', ');
    return joinNotes(
        titles.map((t) => titleNote(t.app, t.title, t.drop)),
        fallback,
        max,
        limit,
    );
}
