import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSource, readBroadcast } from '../src/live.ts';

test('the broadcast block is read with its defaults', () => {
    assert.deepEqual(readBroadcast({ key: 'abc', host: null, port: 443, scheme: 'https', channel: 'timers.studio.7' }), {
        key: 'abc',
        host: null,
        port: 443,
        scheme: 'https',
        channel: 'timers.studio.7',
    });
    // a dev box exposing Reverb on its own port, plain http
    assert.deepEqual(readBroadcast({ key: 'abc', host: '127.0.0.1', port: 8080, scheme: 'http', channel: 'timers.x.1' }), {
        key: 'abc',
        host: '127.0.0.1',
        port: 8080,
        scheme: 'http',
        channel: 'timers.x.1',
    });
    // an empty host is the workspace host; junk falls back rather than breaking
    assert.deepEqual(readBroadcast({ key: 'abc', host: '', port: 'x', scheme: 'ftp', channel: 'c' }), { key: 'abc', host: null, port: 443, scheme: 'https', channel: 'c' });
});

test('no block, or one the app cannot use, means keep polling', () => {
    // An older workspace (no field), one without Reverb (null), and a block
    // missing the two things a subscription cannot do without.
    assert.equal(readBroadcast(undefined), null);
    assert.equal(readBroadcast(null), null);
    assert.equal(readBroadcast({ key: 'abc' }), null);
    assert.equal(readBroadcast({ channel: 'c' }), null);
    assert.equal(readBroadcast({ key: '', channel: 'c' }), null);
    assert.equal(readBroadcast('nope'), null);
});

test('rust is handed a source only when there is something to subscribe to as someone', () => {
    const broadcast = readBroadcast({ key: 'abc', channel: 'c' })!;

    assert.deepEqual(liveSource('https://studio.zebu.work', 'tok', broadcast), { workspace: 'https://studio.zebu.work', token: 'tok', broadcast });
    assert.equal(liveSource('https://studio.zebu.work', 'tok', null), null);
    assert.equal(liveSource('https://studio.zebu.work', '', broadcast), null, 'signed out');
    assert.equal(liveSource('', 'tok', broadcast), null);
});
