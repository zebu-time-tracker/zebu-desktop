import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialPulseState, onPulse, onPushed, PULSE, refetched, type Pulse } from '../src/pulse.ts';

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

test('a pushed change refetches unless it is the one already fetched', () => {
    // The socket only speaks when something moved, so even a token held from
    // nowhere (the first pulse has not been read yet) is a change...
    const fresh = onPushed('tok-1', initialPulseState(), 1_000);
    assert.equal(fresh.refetch, true);
    assert.equal(fresh.state.token, 'tok-1');
    assert.equal(fresh.state.refetchedAt, 1_000);

    // ...the echo of this app's own write, already fetched, is not...
    const echo = onPushed('tok-1', fresh.state, 2_000);
    assert.equal(echo.refetch, false);
    assert.equal(echo.state.refetchedAt, 1_000);

    // ...and a server that could not say what changed is asked.
    const unknown = onPushed(null, echo.state, 3_000);
    assert.equal(unknown.refetch, true);
    assert.equal(unknown.state.token, null);
});

test('the pulse does not fetch a pushed change a second time', () => {
    // The push moved the held token along with the fetch, so the next beat
    // sees the same token and stays quiet.
    const pushed = onPushed('tok-2', onPulse(pulse('tok-1'), initialPulseState(), 0).state, 1_000);
    assert.equal(pushed.refetch, true);

    const beat = onPulse(pulse('tok-2'), pushed.state, 2_000);
    assert.equal(beat.refetch, false);

    // and a change the socket missed is still caught by the beat
    assert.equal(onPulse(pulse('tok-3'), beat.state, 3_000).refetch, true);
});
