import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    candidatesFrom,
    DEFAULT_EXCLUDED,
    groupKey,
    groupSpans,
    parseExcludeList,
    suggestFor,
    summariseTitles,
    timeline,
    timelineRange,
    type FocusSpan,
} from '../src/focus.ts';

const T0 = new Date(2026, 8, 23, 9, 0, 0).getTime();
const min = 60_000;
const span = (app: string, title: string, fromMin: number, toMin: number): FocusSpan => ({ app, title, start: T0 + fromMin * min, end: T0 + toMin * min });

test('browser titles group by the site they end with', () => {
    assert.equal(groupKey('Safari', 'Pull request #12 · zebu-desktop · GitHub'), 'GitHub');
    assert.equal(groupKey('Google Chrome', 'Inbox (3) - alan@zebu.work - Gmail'), 'Gmail');
    assert.equal(groupKey('Firefox', 'Rust docs — Mozilla Firefox'), 'Rust docs');
    assert.equal(groupKey('Arc', '(4) Home / X'), 'Home / X');
    // no site suffix, but a domain in the title
    assert.equal(groupKey('Safari', 'www.example.com/pricing'), 'example.com');
});

test('other apps group by the last meaningful piece of the title', () => {
    assert.equal(groupKey('Code', '● lib.rs — zebu-desktop'), 'zebu-desktop');
    assert.equal(groupKey('Slack', 'general (Channel) - Acme - Slack'), 'Acme');
    assert.equal(groupKey('Terminal', 'zebu-desktop — -zsh — 80×24'), 'zebu-desktop');
    assert.equal(groupKey('Figma', 'Website redesign – Figma'), 'Website redesign');
    assert.equal(groupKey('Finder', ''), '');
});

test('spans add up per app and per group, longest first, clipped to the day', () => {
    const spans = [
        span('Safari', 'PR #12 · zebu · GitHub', 0, 20),
        span('Code', 'lib.rs — zebu-desktop', 20, 80),
        span('Safari', 'Issues · zebu · GitHub', 80, 90),
        span('Safari', 'Weather - BBC', 90, 95),
        span('Code', 'focus.ts — zebu-desktop', -30, 10), // started yesterday evening, say
    ];
    const apps = groupSpans(spans, T0, T0 + 24 * 60 * min);
    assert.deepEqual(
        apps.map((a) => [a.app, a.ms / min]),
        [
            ['Code', 70],
            ['Safari', 35],
        ],
    );
    const safari = apps[1];
    assert.deepEqual(
        safari.groups.map((g) => [g.key, g.ms / min]),
        [
            ['GitHub', 30],
            ['BBC', 5],
        ],
    );
    assert.equal(safari.groups[0].titles[0].title, 'PR #12 · zebu · GitHub');
});

test('the timeline merges touching stretches of one app and places them on the strip', () => {
    const spans = [span('Code', 'a', 0, 30), span('Code', 'b', 30, 60), span('Safari', 'x', 60, 120)];
    const segs = timeline(spans, T0, T0 + 120 * min);
    assert.deepEqual(segs, [
        { app: 'Code', left: 0, width: 0.5 },
        { app: 'Safari', left: 0.5, width: 0.5 },
    ]);
    assert.deepEqual(timelineRange([span('Code', 'a', 5, 70)]), [T0, T0 + 120 * min]);
    assert.equal(timelineRange([]), null);
});

test('the exclude list parses lines and commas, and ships with the password managers', () => {
    assert.deepEqual(parseExcludeList('1Password, Keychain Access\n\n  Signal \n1password'), ['1Password', 'Keychain Access', 'Signal']);
    assert.ok(DEFAULT_EXCLUDED.includes('1Password'));
    assert.ok(DEFAULT_EXCLUDED.includes('Keychain Access'));
});

const projects = [
    { id: 'p1', name: 'Website redesign', code: 'WEB', client: 'Acme', tasks: [{ id: 't1', name: 'Design' }, { id: 't2', name: 'Copywriting' }] },
    { id: 'p2', name: 'Zebu', code: null, client: null, tasks: [{ id: 't3', name: 'Development' }] },
    { id: 'p3', name: 'Internal', code: null, client: null, tasks: [] },
];

test('a group whose titles name a project suggests logging its time there', () => {
    const [figma] = groupSpans([span('Figma', 'Homepage hero – Website redesign – Figma', 0, 80)]);
    const s = suggestFor(figma.groups[0], candidatesFrom(projects, [], null));
    assert.equal(s?.project_id, 'p1');
    assert.equal(s?.minutes, 80);
    assert.equal(s?.label, 'Website redesign');
    assert.equal(s?.notes, 'Homepage hero');
});

test('recent entries teach it words the project name lacks', () => {
    const entries = [{ project_id: 'p2', task_id: 't3', notes: 'zebu-desktop focus view' }];
    const [code] = groupSpans([span('Code', 'focus.ts — zebu-desktop', 0, 45)]);
    const s = suggestFor(code.groups[0], candidatesFrom(projects, entries, null));
    assert.equal(s?.project_id, 'p2');
    // "zebu" matches the project outright; the entry's task only rides along when it scores higher
    assert.ok(s?.label.startsWith('Zebu'));
});

test('the tracked timer wins a tie', () => {
    const both = [
        { id: 'a', name: 'Acme site', code: null, client: null, tasks: [] },
        { id: 'b', name: 'Acme app', code: null, client: null, tasks: [] },
    ];
    const [app] = groupSpans([span('Safari', 'Acme dashboard · Acme', 0, 30)]);
    assert.equal(suggestFor(app.groups[0], candidatesFrom(both, [], { project_id: 'b', task_id: null }))?.project_id, 'b');
});

test('no suggestion for short groups, unmatched titles or half-matched names', () => {
    const cands = candidatesFrom(projects, [], null);
    const [short] = groupSpans([span('Figma', 'Website redesign – Figma', 0, 4)]);
    assert.equal(suggestFor(short.groups[0], cands), null, 'four minutes is not worth an entry');
    const [news] = groupSpans([span('Safari', 'Weather - BBC', 0, 60)]);
    assert.equal(suggestFor(news.groups[0], cands), null);
    // one word of a four-word candidate is not enough (website, redesign, web, acme vs "website")
    const [site] = groupSpans([span('Safari', 'My website builder - Wix', 0, 60)]);
    assert.equal(suggestFor(site.groups[0], cands), null);
    const [untitled] = groupSpans([span('Finder', '', 0, 60)]);
    assert.equal(suggestFor(untitled.groups[0], cands), null);
});

test('notes summarise the longest titles without the repeated site name', () => {
    const [safari] = groupSpans([span('Safari', 'PR #12 · GitHub', 0, 30), span('Safari', 'Issues · GitHub', 30, 40), span('Safari', 'PR #12 · GitHub', 40, 50)]);
    assert.equal(summariseTitles(safari.groups[0]), 'PR #12; Issues');
    const long = { app: 'X', key: '', ms: 0, titles: [{ title: 'a'.repeat(300), ms: 1 }] };
    assert.equal(summariseTitles(long).length, 200);
});

test('a title that is only noise still names the group, unless it is just the app', () => {
    assert.equal(groupKey('Figma', 'Figma Community'), 'Figma Community');
    assert.equal(groupKey('Terminal', '-zsh'), '-zsh');
    assert.equal(groupKey('Figma', 'Figma'), '');
});

// ---- by project (board #512) ----

import { assignTitles, bestCandidate, byProject, logState, notesFor, placeKey, projectOfRow, trackedToday } from '../src/focus.ts';
import { ruleIndex, type FocusRule } from '../src/focusRules.ts';

const DAY: [number, number] = [T0 - 9 * 60 * min, T0 + 15 * 60 * min];
const noRules = ruleIndex([]);
const r = (app: string, key: string, project_id: string): FocusRule => ({ app, key, project_id, workspace: 'w' });

test('a browser title keeps the repository or account before the site as its place', () => {
    assert.equal(placeKey('Safari', 'Add focus view · Pull Request #12 · acme/website · GitHub'), 'acme/website · GitHub');
    assert.equal(placeKey('Google Chrome', 'Inbox (3) - alan@zebu.work - Gmail'), 'alan@zebu.work · Gmail');
    assert.equal(placeKey('Safari', 'Weather - BBC'), 'BBC');
    assert.equal(placeKey('Code', 'a — b — zebu-desktop'), 'zebu-desktop', 'only browsers split finer');
});

test('titles are filed by project: two repositories on one site go to two projects', () => {
    const spans = [
        span('Safari', 'Fix nav · Pull Request #3 · acme/website · GitHub', 0, 20),
        span('Safari', 'Focus by project · Issue #512 · zebu-time-tracker/zebu-desktop · GitHub', 20, 50),
        span('Code', 'focus.ts — zebu-desktop', 50, 110),
        span('Figma', 'Homepage hero – Website redesign – Figma', 110, 150),
        span('Safari', 'Weather - BBC', 150, 160),
        span('Finder', '', 160, 165),
    ];
    const groups = byProject(assignTitles(spans, ...DAY, candidatesFrom(projects, [], null), noRules));
    assert.deepEqual(
        groups.map((g) => [g.project_id, g.ms / min]),
        [
            ['p2', 90],
            ['p1', 60],
            [null, 15],
        ],
    );
    assert.deepEqual(
        groups[1].places.map((p) => [p.app, p.key]),
        [
            ['Figma', 'Website redesign'],
            ['Safari', 'acme/website · GitHub'],
        ],
    );
    assert.deepEqual(
        groups[2].places.map((p) => [p.app, p.key]),
        [
            ['Safari', 'BBC'],
            ['Finder', ''],
        ],
        'Unassigned comes last',
    );
});

test('rules beat guesses, except a rule for all of a browser site', () => {
    const spans = [
        span('Safari', 'Focus · Issue #512 · zebu-time-tracker/zebu-desktop · GitHub', 0, 30),
        span('Safari', 'Fix nav · Pull Request #3 · acme/website · GitHub', 30, 35),
        span('Safari', 'Notifications · GitHub', 35, 40),
        span('Safari', 'Zebu pricing - Example', 40, 45),
        span('Safari', 'Weather - BBC', 45, 50),
        span('Slack', 'general (Channel) - Acme - Slack', 50, 70),
        span('Figma', 'Logo – Zebu – Figma', 70, 80),
        span('Figma', 'Untitled – Figma', 80, 90),
    ];
    const rules = ruleIndex([
        r('Safari', 'GitHub', 'p3'),
        r('Safari', '', 'p3'),
        r('Slack', 'Acme', 'p1'),
        r('Figma', '', 'p1'),
        r('Chrome', 'zebu-time-tracker/zebu-desktop · GitHub', 'p3'),
    ]);
    const assigned = assignTitles(spans, ...DAY, candidatesFrom(projects, [], null), rules);
    const of = (title: string) => assigned.find((a) => a.title.startsWith(title))?.project_id;
    assert.equal(of('Focus'), 'p3', 'the repository rule (made in Chrome) beats the title naming Zebu');
    assert.equal(of('Fix nav'), 'p1', 'a page naming a project beats the rule for all of GitHub');
    assert.equal(of('Notifications'), 'p3', 'the site rule fills in');
    assert.equal(of('Zebu pricing'), 'p2', 'a page naming a project beats the rule for all of Safari');
    assert.equal(of('Weather'), 'p3', 'the browser rule fills in');
    assert.equal(of('general'), 'p1', 'the Slack workspace rule');
    assert.equal(of('Logo'), 'p1', 'an app-wide rule beats the title naming Zebu');
    assert.equal(of('Untitled'), 'p1');
});

test('the client backs a match up but cannot make one, and addresses are ignored', () => {
    const cands = candidatesFrom([{ id: 'w', name: 'Website redesign', code: 'WEB', client: 'Acme Corp', tasks: [] }, { id: 'z', name: 'Zebu', code: null, client: null, tasks: [] }], [], null);
    assert.equal(bestCandidate('Homepage hero – Website redesign – Figma', cands)?.project_id, 'w', 'a long client name does not water the name down');
    assert.equal(bestCandidate('Issues · acme/website · GitHub', cands)?.project_id, 'w', 'one word of the name and one of the client');
    assert.equal(bestCandidate('general - Acme Corp - Slack', cands), null, 'the client alone names no project');
    assert.equal(bestCandidate('Inbox — alan@zebu.work', cands), null, 'an inbox is not the project its domain spells');
});

test('a rule names the project; a title naming one of its tasks keeps the task', () => {
    const spans = [span('Figma', 'Homepage – Website redesign Design – Figma', 0, 30)];
    const [a] = assignTitles(spans, ...DAY, candidatesFrom(projects, [], null), ruleIndex([r('Figma', 'Website redesign Design', 'p1')]));
    assert.equal(a.project_id, 'p1');
    assert.equal(a.task_id, 't1');
});

test('a project group takes the task most of its time matched', () => {
    const spans = [span('Figma', 'Hero – Website redesign Design – Figma', 0, 30), span('Safari', 'Issues · acme/website · GitHub', 30, 40)];
    const [g] = byProject(assignTitles(spans, ...DAY, candidatesFrom(projects, [], null), noRules));
    assert.equal(g.project_id, 'p1');
    assert.equal(g.task_id, 't1');
});

test('a By app row is tagged with the project most of its time went to', () => {
    const spans = [
        span('Safari', 'PR · acme/website · GitHub', 0, 20),
        span('Safari', 'Issue · zebu-time-tracker/zebu · GitHub', 20, 30),
        span('Safari', 'Weather - BBC', 30, 90),
    ];
    const assigned = assignTitles(spans, ...DAY, candidatesFrom(projects, [], null), noRules);
    assert.equal(projectOfRow(assigned, 'Safari', 'GitHub'), 'p1');
    assert.equal(projectOfRow(assigned, 'Safari', 'BBC'), null);
    assert.equal(projectOfRow(assigned, 'Safari'), null, 'most of Safari went nowhere');
});

test('time already tracked today comes off what is offered, so nothing is logged twice', () => {
    const today = '2026-09-23';
    const entries = [
        { project_id: 'p1', date: today, minutes: 30, timer_started_at: null },
        { project_id: 'p1', date: '2026-09-22', minutes: 300, timer_started_at: null },
        { project_id: 'p2', date: today, minutes: 10, timer_started_at: new Date(T0).toISOString() },
    ];
    const tracked = trackedToday(entries, today, T0 + 20 * min);
    assert.equal(tracked.get('p1'), 30);
    assert.equal(tracked.get('p2'), 30, 'a running timer counts up to now');
    assert.deepEqual(logState(80 * min, 30), { focused: 80, minutes: 50, state: 'log' });
    assert.deepEqual(logState(32 * min, 30), { focused: 32, minutes: 2, state: 'logged' });
    assert.deepEqual(logState(20 * min, 45), { focused: 20, minutes: 0, state: 'logged' });
    assert.deepEqual(logState(3 * min, 0), { focused: 3, minutes: 3, state: 'none' });
});

test('a project group notes its longest titles without the places they repeat', () => {
    const spans = [
        span('Figma', 'Homepage hero – Website redesign – Figma', 0, 40),
        span('Safari', 'Fix nav · Pull Request #3 · acme/website · GitHub', 40, 60),
        span('Code', 'site.css — website', 60, 65),
    ];
    const [g] = byProject(assignTitles(spans, ...DAY, candidatesFrom(projects, [], null), ruleIndex([r('Code', 'website', 'p1')])));
    assert.equal(notesFor(g), 'Homepage hero; Fix nav · Pull Request #3; site.css');
    const bare = { project_id: null, task_id: null, ms: 0, places: [{ app: 'Finder', key: '', ms: 1, titles: [] }] };
    assert.equal(notesFor(bare), 'Finder');
});
