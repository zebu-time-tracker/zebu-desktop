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
