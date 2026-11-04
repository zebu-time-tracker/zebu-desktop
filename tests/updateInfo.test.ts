import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, versionsBehind } from '../src/updateInfo.ts';

const releases = ['0.1.13', '0.2.0', '0.2.1', '0.2.2', '0.2.3'];

test('versions compare as numbers, not text', () => {
    assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
    assert.equal(compareVersions('0.2.3', '0.2.3'), 0);
    assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
});

test('counts the releases after the running one, up to the one on offer', () => {
    assert.equal(versionsBehind('0.2.2', '0.2.3', releases), 1);
    assert.equal(versionsBehind('0.2.0', '0.2.3', releases), 3);
    assert.equal(versionsBehind('0.1.13', '0.2.3', releases), 4);
    // a build between releases (a dev build) counts only what came after it
    assert.equal(versionsBehind('0.1.20', '0.2.3', releases), 4);
    // releases newer than the one on offer are not counted
    assert.equal(versionsBehind('0.2.0', '0.2.2', releases), 2);
});

test('gives null rather than a guess when the manifest cannot say', () => {
    assert.equal(versionsBehind('0.2.0', '0.2.3', undefined), null); // a manifest from before the field
    assert.equal(versionsBehind('0.2.0', '0.2.3', 'nope'), null);
    assert.equal(versionsBehind('0.2.0', '0.2.4', releases), null); // the offer is not in the list
    assert.equal(versionsBehind('0.2.3', '0.2.3', releases), null);
    assert.equal(versionsBehind('0.2.0-beta', '0.2.3', releases), null);
});

test('ignores junk and duplicates in the list', () => {
    assert.equal(versionsBehind('0.2.0', '0.2.3', ['0.2.1', '0.2.1', 'x', 7, null, '0.2.3']), 2);
});
