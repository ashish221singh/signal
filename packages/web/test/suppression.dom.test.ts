// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetForTests, Signal } from '../src/index.js';
import { isSuppressed, markSuppressed } from '../src/suppression.js';
import { flushMicrotasks, makeConfig, makeFetch } from './helpers.js';

const KEY = 'pk_test_123';
const API = 'https://api.test';

describe('local suppression short-circuit (F2-D11)', () => {
  beforeEach(() => {
    __resetForTests();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('marks and reads a client-side cooldown', () => {
    expect(isSuppressed('u1', 'evt')).toBe(false);
    markSuppressed('u1', 'evt', 60_000, 1000);
    expect(isSuppressed('u1', 'evt', 2000)).toBe(true);
    expect(isSuppressed('u1', 'evt', 100_000)).toBe(false); // cooldown elapsed
    expect(isSuppressed('u1', 'other')).toBe(false); // per-event
  });

  it('a suppressed (user,event) skips the eligibility network entirely', async () => {
    const { fetch, calls } = makeFetch([
      {
        match: (u) => u.includes('/eligibility'),
        respond: () => ({ status: 200, body: makeConfig() }),
      },
      { match: (u) => u.includes('/response'), respond: () => ({ status: 204 }) },
    ]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch, userId: 'u1' });
    // Pre-seed a local suppression for this subject+event.
    markSuppressed('u1', 'checkout_completed');
    await Signal.track('checkout_completed');
    await flushMicrotasks();
    expect(calls.some((c) => c.url.includes('/eligibility'))).toBe(false);
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });
});
