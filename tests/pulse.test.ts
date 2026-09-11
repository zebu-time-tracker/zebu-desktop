import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialPulseState, onPulse, onUnavailable, PULSE, readWindow, refetched, retryAfterSeconds, type Pulse } from '../src/pulse.ts';

const pulse = (token: string, running = true): Pulse => ({ token, running });

test('the first answer is not a change', () => {
    // Learning the token for the first time says nothing about whether anything
    // moved. Counting it as a change would mean a redundant full fetch on every
    // launch, and again after every outage.
    const decision = onPulse(pulse('abc'), initialPulseState(), 1_000);

    assert.equal(decision.refetch, false);
    assert.equal(decision.state.token, 'abc');
});

test('a token that moves refetches, one that holds does not', () => {
    let state = onPulse(pulse('abc'), initialPulseState(), 1_000).state;

    const same = onPulse(pulse('abc'), state, 2_000);
    assert.equal(same.refetch, false);

    const moved = onPulse(pulse('def'), same.state, 3_000);
    assert.equal(moved.refetch, true);
    assert.equal(moved.state.token, 'def');
});

test('a running clock is asked about every two seconds, an idle one every thirty', () => {
    const state = initialPulseState();

    assert.equal(onPulse(pulse('abc', true), state, 0).nextIn, 2_000);
    assert.equal(onPulse(pulse('abc', false), state, 0).nextIn, 30_000);
});

test('everything is refetched every five minutes even when nothing moved', () => {
    // The token has one-second granularity, so two edits inside one second look
    // identical. This is what eventually notices.
    let state = onPulse(pulse('abc'), initialPulseState(), 0).state;

    const early = onPulse(pulse('abc'), state, PULSE.fallback - 1);
    assert.equal(early.refetch, false);

    const due = onPulse(pulse('abc'), early.state, PULSE.fallback);
    assert.equal(due.refetch, true);
    // …and the clock restarts, so it is every five minutes rather than every
    // beat from then on.
    assert.equal(onPulse(pulse('abc'), due.state, PULSE.fallback + 1).refetch, false);
});

test('an unreachable pulse still converges, but slowly', () => {
    // An outage of the cheap endpoint must not multiply the load on the
    // expensive one. Falling back at the running cadence would do exactly that.
    const first = onPulse(null, initialPulseState(), 10_000);
    assert.equal(first.refetch, true);
    assert.equal(first.nextIn, PULSE.unreachable);

    const tooSoon = onPulse(null, first.state, 10_000 + PULSE.unreachable - 1);
    assert.equal(tooSoon.refetch, false);

    const due = onPulse(null, tooSoon.state, 10_000 + PULSE.unreachable);
    assert.equal(due.refetch, true);
});

test('a run of failures arriving faster than the backoff still refetches on schedule', () => {
    // Every beat resetting the clock would mean a fast enough failure loop
    // never refetching at all.
    let state = onPulse(null, initialPulseState(), 0).state;
    for (let t = 1_000; t < PULSE.unreachable; t += 1_000) {
        const decision = onPulse(null, state, t);
        assert.equal(decision.refetch, false, `refetched again at ${t}ms`);
        state = decision.state;
    }

    assert.equal(onPulse(null, state, PULSE.unreachable).refetch, true);
});

test('recovering from an outage does not refetch just for learning the token again', () => {
    const down = onPulse(null, initialPulseState(), 0);
    const back = onPulse(pulse('abc'), down.state, 1_000);

    assert.equal(back.refetch, false);
    assert.equal(back.state.failedAt, null);
});

test('a fetch the app made for its own reasons pushes the backstop out', () => {
    const state = refetched(onPulse(pulse('abc'), initialPulseState(), 0).state, PULSE.fallback);

    assert.equal(onPulse(pulse('abc'), state, PULSE.fallback + 1).refetch, false);
});

// ---------------------------------------------------------------------------
// A planned outage (board #216). The server announces it on the pulse before it
// starts, then answers 503 with Retry-After for its duration.
// ---------------------------------------------------------------------------

const WINDOW = { starts_at: '2026-09-11T21:00:00.000Z', ends_at: '2026-09-11T21:30:00.000Z' };
const at = (iso: string) => Date.parse(iso);
const announced = (token: string, running = true): Pulse => ({ token, running, maintenance: WINDOW });

test('an announced window changes nothing until it is nearly here', () => {
    // Half an hour out, with a clock running: still every two seconds.
    assert.equal(onPulse(announced('abc'), initialPulseState(), at('2026-09-11T20:30:00.000Z')).nextIn, PULSE.running);
});

test('the beat that would land inside the outage is not made at all', () => {
    // A second before it starts, the next running beat would arrive after it
    // had — so wait the window out rather than ask a box that is going down.
    const decision = onPulse(announced('abc'), initialPulseState(), at('2026-09-11T20:59:59.000Z'));

    assert.ok(decision.nextIn > PULSE.running);
});

test('during the window the wait runs to its end, and is capped', () => {
    const decision = onPulse(announced('abc'), initialPulseState(), at('2026-09-11T21:01:00.000Z'));

    // 29 minutes left, so the cap applies rather than one 29-minute sleep.
    assert.equal(decision.nextIn, PULSE.maxHold);
});

test('close to the end the wait is exactly what is left, plus the grace', () => {
    const decision = onPulse(announced('abc'), initialPulseState(), at('2026-09-11T21:29:00.000Z'));

    assert.equal(decision.nextIn, 60_000 + PULSE.grace);
});

test('a window that is over holds nothing back', () => {
    assert.equal(onPulse(announced('abc'), initialPulseState(), at('2026-09-11T21:30:00.000Z')).nextIn, PULSE.running);
});

test('an announcement that cannot be read is not obeyed', () => {
    // Half-understanding a window and going quiet for it is worse than ignoring
    // it: the app would stop polling a server that is perfectly well.
    const nonsense: Pulse = { token: 'abc', running: true, maintenance: { starts_at: 'soon', ends_at: 'later' } };

    assert.equal(onPulse(nonsense, initialPulseState(), at('2026-09-11T21:01:00.000Z')).nextIn, PULSE.running);
});

test('a refusal waits as long as the server asked, and refetches nothing', () => {
    const decision = onUnavailable(90_000, initialPulseState(), 1_000);

    assert.equal(decision.refetch, false);
    assert.equal(decision.nextIn, 90_000);
    assert.equal(decision.state.failedAt, 1_000);
});

test('a refusal without a Retry-After still waits, and never hammers', () => {
    assert.equal(onUnavailable(null, initialPulseState(), 0).nextIn, PULSE.unreachable);
    // Even a server asking to be called back immediately gets the grace.
    assert.equal(onUnavailable(0, initialPulseState(), 0).nextIn, PULSE.grace);
    assert.equal(onUnavailable(60 * 60_000, initialPulseState(), 0).nextIn, PULSE.maxHold);
});

test('a refusal is not an unreachable server: there is nothing to converge on', () => {
    // The unreachable path refetches to catch up. Refetching here would ask the
    // expensive endpoint for a payload that is being refused too.
    assert.equal(onPulse(null, initialPulseState(), 0).refetch, true);
    assert.equal(onUnavailable(30_000, initialPulseState(), 0).refetch, false);
});

test('the first pulse after the window clears the failure', () => {
    const down = onUnavailable(30_000, initialPulseState(), 0);
    const back = onPulse(pulse('abc'), down.state, at('2026-09-11T21:31:00.000Z'));

    assert.equal(back.state.failedAt, null);
});

test('Retry-After is read only when it says something usable', () => {
    assert.equal(retryAfterSeconds('900'), 900);
    assert.equal(retryAfterSeconds('1'), 1);

    // Nothing usable is null — "unknown", which the caller turns into a wait.
    // Reading any of these as 0 would mean coming straight back.
    assert.equal(retryAfterSeconds(null), null);
    assert.equal(retryAfterSeconds(''), null);
    assert.equal(retryAfterSeconds('   '), null);
    assert.equal(retryAfterSeconds('0'), null);
    assert.equal(retryAfterSeconds('-5'), null);
    assert.equal(retryAfterSeconds('soon'), null);
    // The header's other legal form, which this server does not send.
    assert.equal(retryAfterSeconds('Fri, 11 Sep 2026 21:30:00 GMT'), null);
});

test('a window is read only when both of its times are real dates', () => {
    assert.deepEqual(readWindow(WINDOW), WINDOW);

    // Anything less is no window at all. Going quiet on a half-understood
    // announcement would silence the app against a server that is fine.
    assert.equal(readWindow(undefined), null);
    assert.equal(readWindow(null), null);
    assert.equal(readWindow({}), null);
    assert.equal(readWindow({ starts_at: WINDOW.starts_at }), null);
    assert.equal(readWindow({ starts_at: 'soon', ends_at: 'later' }), null);
    assert.equal(readWindow({ starts_at: WINDOW.starts_at, ends_at: 42 }), null);
});
