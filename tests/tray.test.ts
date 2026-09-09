// Unit tests for the tray description handed to Rust. Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TIME_PLACEHOLDER, trayEntry } from '../src/tray.ts';

// a stand-in for vue-i18n's t(): key plus its named params, so the tests see
// exactly what was asked for
const t = (key: string, named: Record<string, unknown>) => `${key}|${named.detail ?? ''}|${named.time}`;

test('nothing to show is null, which Rust paints as the idle pill', () => {
    assert.equal(trayEntry(null, t), null);
});

test('a running entry carries its start so Rust can tick without the webview', () => {
    const entry = trayEntry({ minutes: 20, timer_started_at: '2026-09-09T10:00:00+00:00', project: 'Acme', task: 'Design' }, t);
    assert.deepEqual(entry, {
        minutes: 20,
        started_at_ms: Date.parse('2026-09-09T10:00:00Z'),
        detail: 'Acme · Design',
        tooltip: `tray.tooltipRunning|Acme · Design|${TIME_PLACEHOLDER}`,
        agent_waiting: false,
    });
});

test('a stopped entry has no start and uses the stopped tooltip', () => {
    const entry = trayEntry({ minutes: 125, timer_started_at: null, project: 'Acme', task: null }, t);
    assert.equal(entry?.started_at_ms, null);
    assert.equal(entry?.detail, 'Acme');
    assert.equal(entry?.tooltip, `tray.tooltipStopped|Acme|${TIME_PLACEHOLDER}`);
});

test('the placeholder is left literal for the ticker to fill in', () => {
    const entry = trayEntry({ minutes: 0, timer_started_at: null, project: null, task: null }, t);
    assert.equal(entry?.detail, null);
    assert.equal(entry?.tooltip, `tray.tooltipIdle||{time}`);
});

test('waiting on an agent only counts while the timer runs', () => {
    assert.equal(trayEntry({ minutes: 0, timer_started_at: '2026-09-09T10:00:00Z', project: 'A', task: null, agent_waiting: true }, t)?.agent_waiting, true);
    assert.equal(trayEntry({ minutes: 0, timer_started_at: null, project: 'A', task: null, agent_waiting: true }, t)?.agent_waiting, false);
});

test('an unparseable start reads as stopped rather than a frozen clock', () => {
    const entry = trayEntry({ minutes: 5, timer_started_at: 'not a date', project: 'A', task: null }, t);
    assert.equal(entry?.started_at_ms, null);
});
