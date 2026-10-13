import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectOption } from '../src/api.ts';
import { focusLeftPicker, groupBy, homeIndex, listKey, pointerMoved, settleActive, step, type ListChange, type ListKeyPress } from '../src/picker.ts';

const project = (id: string, client: string | null): ProjectOption => ({ id, name: id, code: null, client, tasks: [] });
const groupByClient = (projects: ProjectOption[], start = 0) =>
    groupBy(projects, (p) => p.client ?? '', start).map((g) => ({ client: g.key, projects: g.items, offset: g.offset }));

test('a client group sits where its best-ranked project ranked, and keeps that order inside', () => {
    // the order below is what the fuzzy filter returned
    const groups = groupByClient([project('a1', 'Acme'), project('b1', 'Bob'), project('a2', 'Acme'), project('b2', 'Bob')]);

    assert.deepEqual(
        groups.map((g) => [g.client, g.projects.map((p) => p.id)]),
        [
            ['Acme', ['a1', 'a2']],
            ['Bob', ['b1', 'b2']],
        ],
    );
});

test('offsets index the flattened rows, so keyboard navigation walks the groups as rendered', () => {
    const groups = groupByClient([project('a1', 'Acme'), project('b1', 'Bob'), project('a2', 'Acme')]);
    const rows = groups.flatMap((g) => g.projects);

    assert.deepEqual(groups.map((g) => g.offset), [0, 2]);
    assert.deepEqual(rows.map((p) => p.id), ['a1', 'a2', 'b1']);
    for (const g of groups) for (const [i, p] of g.projects.entries()) assert.equal(rows[g.offset + i], p);
});

test('projects without a client land in one group of their own', () => {
    const groups = groupByClient([project('loose', null), project('a1', 'Acme'), project('other', null)]);

    assert.deepEqual(
        groups.map((g) => [g.client, g.projects.map((p) => p.id)]),
        [
            ['', ['loose', 'other']],
            ['Acme', ['a1']],
        ],
    );
});

test('no projects means no groups', () => {
    assert.deepEqual(groupByClient([]), []);
});

test('a row above the groups pushes every offset down by one', () => {
    // the task picker's "no task" row sits above the list
    const groups = groupByClient([project('a1', 'Acme'), project('b1', 'Bob')], 1);

    assert.deepEqual(groups.map((g) => g.offset), [1, 2]);
});

// Closing the open list when focus leaves it, without closing it on the very
// click that opened it (board #136). A stub Node is enough: the whole decision
// is "is this element inside that one".
const node = (children: unknown[] = []): Node => ({ contains: (other: Node) => children.includes(other) }) as unknown as Node;

test('focus landing inside the picker keeps the list open', () => {
    const row = {} as Node;

    assert.equal(focusLeftPicker(node([row]), row), false);
});

test('focus landing elsewhere closes the list', () => {
    assert.equal(focusLeftPicker(node([]), {} as Node), true);
});

test('focus landing nowhere closes the list', () => {
    // document.activeElement is null while a document is being torn down.
    assert.equal(focusLeftPicker(node([]), null), true);
});

test('a picker that is no longer on the page decides nothing', () => {
    // The frame's wait can outlive the component; closing a picker that is gone
    // is pointless, and asking `contains` of nothing would throw.
    assert.equal(focusLeftPicker(null, {} as Node), false);
});

// ---- the highlighted row (board #501) -------------------------------------

const key = (key: string, more: Partial<ListKeyPress> = {}): ListKeyPress => ({ key, isComposing: false, keyCode: 0, ...more });

test('arrows walk the list, Return picks, Escape backs out', () => {
    assert.equal(listKey(key('ArrowDown')), 'next');
    assert.equal(listKey(key('ArrowUp')), 'prev');
    assert.equal(listKey(key('Enter')), 'pick');
    assert.equal(listKey(key('Escape')), 'close');
});

test('every other key is left to the search field', () => {
    for (const k of ['a', 'Backspace', 'Tab', 'ArrowLeft', 'Home']) assert.equal(listKey(key(k)), null);
});

test('a key that belongs to an input method picks nothing', () => {
    // Return confirming a composition, as Chromium reports it and as WebKit does
    assert.equal(listKey(key('Enter', { isComposing: true })), null);
    assert.equal(listKey(key('Enter', { keyCode: 229 })), null);
    assert.equal(listKey(key('ArrowDown', { isComposing: true })), null);
});

test('the arrows stop at either end rather than wrapping', () => {
    assert.equal(step(0, 1, 3), 1);
    assert.equal(step(2, 1, 3), 2);
    assert.equal(step(0, -1, 3), 0);
});

test('an empty list has no highlight, and the first arrow after one lands on the top row', () => {
    assert.equal(step(0, 1, 0), -1);
    assert.equal(step(-1, 1, 3), 0);
    assert.equal(step(-1, -1, 3), 0);
});

test('the list opens on the current choice, or the top when it is not listed', () => {
    assert.equal(homeIndex(['a', 'b', 'c'], 'b'), 1);
    assert.equal(homeIndex(['a', 'b', 'c'], 'x'), 0);
    assert.equal(homeIndex(['', 't1', 't2'], ''), 0); // nothing chosen: the "no task" row
    assert.equal(homeIndex([], 'a'), -1);
});

const change = (over: Partial<ListChange>): ListChange => ({ ids: [], prevIds: [], index: 0, queryChanged: false, query: '', selected: '', ...over });

test('a refetch keeps the highlight on the same project, wherever it now sits', () => {
    // ↓ ↓ ↓ then the timesheet refreshes: Return must still pick p4, not the first row
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
    assert.equal(settleActive(change({ ids: [...ids], prevIds: ids, index: 3 })), 3);
    // a project added above it moves its row, not the highlight off it
    assert.equal(settleActive(change({ ids: ['p0', ...ids], prevIds: ids, index: 3 })), 4);
});

test('a highlighted row that disappeared leaves the highlight where it was, inside the list', () => {
    assert.equal(settleActive(change({ ids: ['p1', 'p2', 'p4'], prevIds: ['p1', 'p2', 'p3', 'p4'], index: 2 })), 2);
    assert.equal(settleActive(change({ ids: ['p1'], prevIds: ['p1', 'p2', 'p3'], index: 2 })), 0);
});

test('typing ranks the list afresh, so the best match is highlighted', () => {
    assert.equal(settleActive(change({ ids: ['p3', 'p1'], prevIds: ['p1', 'p2', 'p3'], index: 2, queryChanged: true, query: 'br' })), 0);
});

test('clearing the query goes back to the current choice', () => {
    assert.equal(settleActive(change({ ids: ['p1', 'p2', 'p3'], prevIds: ['p3'], index: 0, queryChanged: true, query: '', selected: 'p2' })), 1);
});

test('nothing matching means nothing for Return to pick', () => {
    assert.equal(settleActive(change({ ids: [], prevIds: ['p1'], index: 0, queryChanged: true, query: 'zzz' })), -1);
});

test('only a pointer that moved takes the highlight', () => {
    // the list scrolling under a resting pointer reports the same screen position
    assert.equal(pointerMoved({ x: 10, y: 20 }, { x: 10, y: 20 }), false);
    assert.equal(pointerMoved({ x: 10, y: 20 }, { x: 10, y: 21 }), true);
    assert.equal(pointerMoved(null, { x: 10, y: 20 }), true);
});
