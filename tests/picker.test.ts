import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectOption } from '../src/api.ts';
import { groupByClient } from '../src/picker.ts';

const project = (id: string, client: string | null): ProjectOption => ({ id, name: id, code: null, client, tasks: [] });

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
