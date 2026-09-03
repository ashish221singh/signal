// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetForTests, Signal } from '../src/index.js';
import { flushMicrotasks, makeConfig, makeFetch } from './helpers.js';

const KEY = 'pk_test_123';
const API = 'https://api.test';

function eligibilityRoute(status: number, body?: unknown) {
  return {
    match: (url: string) => url.includes('/v1/sdk/eligibility'),
    respond: () => ({ status, body }),
  };
}
const responseRoute = {
  match: (url: string) => url.includes('/v1/sdk/response'),
  respond: () => ({ status: 204 }),
};

describe('Signal lifecycle (init/track)', () => {
  beforeEach(() => {
    __resetForTests();
    localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('track before init is a no-op + one dev warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await Signal.track('checkout_completed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });

  it('double init is idempotent (no duplicate instance)', async () => {
    const { fetch } = makeFetch([eligibilityRoute(204)]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch });
    Signal.init(KEY, { apiUrl: 'https://other.test', fetchImpl: fetch });
    // A track still works against the updated instance (no throw, no sheet on 204).
    await Signal.track('checkout_completed');
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });

  it('eligible track mounts the web-core sheet', async () => {
    const { fetch, calls } = makeFetch([eligibilityRoute(200, makeConfig()), responseRoute]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch });
    await Signal.track('checkout_completed', { context: 'checkout' });
    await flushMicrotasks();
    expect(document.querySelector('[data-signal-sheet]')).not.toBeNull();
    // The eligibility call carried the app key header + event/user query.
    const elig = calls.find((c) => c.url.includes('/eligibility'));
    expect(elig?.headers['X-Signal-App-Key']).toBe(KEY);
    expect(elig?.url).toContain('event_name=checkout_completed');
    expect(elig?.url).toContain('user_id=');
  });

  it('not-eligible (204) shows nothing', async () => {
    const { fetch } = makeFetch([eligibilityRoute(204)]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch });
    await Signal.track('checkout_completed');
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });

  it('persists + reuses an anonymous id in localStorage (F2-D9)', async () => {
    const { fetch, calls } = makeFetch([eligibilityRoute(204)]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch });
    await Signal.track('evt_a');
    const anon = localStorage.getItem('signal_anon_id');
    expect(anon).toBeTruthy();
    // A second, distinct event reuses the same anon id.
    await Signal.track('evt_b');
    const userIds = calls
      .filter((c) => c.url.includes('/eligibility'))
      .map((c) => new URL(c.url).searchParams.get('user_id'));
    expect(userIds[0]).toBe(anon);
    expect(userIds[1]).toBe(anon);
  });

  it('identify() sets the client user id used for subsequent tracks (F5)', async () => {
    const { fetch, calls } = makeFetch([eligibilityRoute(204)]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch });
    Signal.identify('usr_777', { name: 'Jane', email: 'jane@acme.com' });
    await Signal.track('evt');
    const elig = calls.find((c) => c.url.includes('/eligibility'));
    expect(new URL(elig?.url ?? '').searchParams.get('user_id')).toBe('usr_777');
  });

  it('a host-supplied userId supersedes the anon id', async () => {
    const { fetch, calls } = makeFetch([eligibilityRoute(204)]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch, userId: 'user-42' });
    await Signal.track('evt');
    const elig = calls.find((c) => c.url.includes('/eligibility'));
    expect(new URL(elig?.url ?? '').searchParams.get('user_id')).toBe('user-42');
  });

  it('fail-silent when eligibility errors/times out (F2-D10)', async () => {
    const throwing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    Signal.init(KEY, { apiUrl: API, fetchImpl: throwing });
    await expect(Signal.track('evt')).resolves.toBeUndefined();
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });

  it('fail-silent on 401 (revoked key)', async () => {
    const { fetch } = makeFetch([eligibilityRoute(401, { error: {} })]);
    Signal.init(KEY, { apiUrl: API, fetchImpl: fetch });
    await Signal.track('evt');
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });
});
