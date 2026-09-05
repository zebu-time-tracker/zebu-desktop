// Unit tests for the workspace address normaliser. Run with `npm test`
// (Node's built-in runner with type stripping — no extra tooling).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateWorkspaceOrigin, resolveWorkspace, workspaceUrl } from '../src/workspace.ts';

test('a bare name is completed with the hosted domain', () => {
    assert.equal(workspaceUrl('studio'), 'https://studio.zebu.work');
    assert.equal(workspaceUrl('  Studio  '), 'https://studio.zebu.work');
    assert.equal(workspaceUrl('my-team'), 'https://my-team.zebu.work');
});

test('a host or full URL is reduced to its origin', () => {
    assert.equal(workspaceUrl('studio.zebu.work'), 'https://studio.zebu.work');
    assert.equal(workspaceUrl('Studio.Zebu.Work/login?x=1#y'), 'https://studio.zebu.work');
    assert.equal(workspaceUrl('https://studio.zebu.work/'), 'https://studio.zebu.work');
    assert.equal(workspaceUrl('https://studio.zebu.work/time'), 'https://studio.zebu.work');
});

test('the old {sub}.app.zebu.work layout is never produced for bare names', () => {
    assert.equal(workspaceUrl('studio').includes('.app.zebu.work'), false);
    assert.equal(workspaceUrl('studio').includes('zebu.app'), false);
});

test('plain http is fine for loopback hosts, refused elsewhere in release builds', () => {
    assert.equal(workspaceUrl('http://127.0.0.1:8003/'), 'http://127.0.0.1:8003');
    assert.equal(workspaceUrl('http://localhost:8000'), 'http://localhost:8000');
    assert.equal(workspaceUrl('http://zebu.localhost'), 'http://zebu.localhost');
    assert.equal(workspaceUrl('http://studio.zebu.test'), 'http://studio.zebu.test');
    assert.deepEqual(resolveWorkspace('http://studio.zebu.work'), { ok: false, reason: 'insecure' });
    assert.equal(workspaceUrl('http://studio.zebu.work', { allowInsecure: true }), 'http://studio.zebu.work');
});

test('the central site is not a workspace', () => {
    for (const input of ['zebu.work', 'app.zebu.work', 'https://app.zebu.work/login', 'www.zebu.work']) {
        assert.deepEqual(resolveWorkspace(input), { ok: false, reason: 'central' }, input);
    }
});

test('junk is rejected', () => {
    assert.deepEqual(resolveWorkspace(''), { ok: false, reason: 'empty' });
    assert.deepEqual(resolveWorkspace('   '), { ok: false, reason: 'empty' });
    assert.deepEqual(resolveWorkspace('stu dio'), { ok: false, reason: 'invalid' });
    assert.deepEqual(resolveWorkspace('ftp://studio.zebu.work'), { ok: false, reason: 'invalid' });
    assert.deepEqual(resolveWorkspace('https://user:pw@studio.zebu.work'), { ok: false, reason: 'invalid' });
    assert.deepEqual(resolveWorkspace('http://'), { ok: false, reason: 'invalid' });
});

test('stored origins from the old layout migrate to zebu.work', () => {
    assert.equal(migrateWorkspaceOrigin('https://studio.app.zebu.work'), 'https://studio.zebu.work');
    assert.equal(migrateWorkspaceOrigin('https://studio.zebu.work'), 'https://studio.zebu.work');
    assert.equal(migrateWorkspaceOrigin('http://127.0.0.1:8003'), 'http://127.0.0.1:8003');
});
