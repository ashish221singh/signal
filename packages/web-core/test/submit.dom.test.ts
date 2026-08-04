// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { Action } from '../src/index.js';
import { cleanup, makeConfig, makeHost, mount, q, qa, tick } from './helpers.js';

afterEach(cleanup);

async function submitPositive(action: Action, host = makeHost()) {
  mount(document.body, makeConfig({ positive_action: action }), host);
  await tick();
  qa<HTMLButtonElement>('.sig-face')
    .find((f) => f.dataset.value === '3')
    ?.click();
  await tick();
  return host;
}

describe('post-submit actions (DOM)', () => {
  it('type:none → records then closes the sheet', async () => {
    const host = await submitPositive({ type: 'none' });
    expect(host.calls).toContain('submit');
    // closed: the sheet host element is gone
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });

  it('type:thanks → shows the message', async () => {
    const host = await submitPositive({ type: 'thanks', message: 'You rock' });
    expect(host.calls).toContain('submit');
    expect(q('.sig-done-msg')?.textContent).toBe('You rock');
  });

  it('type:redirect → records BEFORE calling host.openUrl', async () => {
    const host = await submitPositive({ type: 'redirect', url: 'https://example.com/next' });
    // submit must come before the openUrl in the call log (record before redirect)
    const submitIdx = host.calls.indexOf('submit');
    const redirectIdx = host.calls.findIndex((c) => c.startsWith('openUrl:'));
    expect(submitIdx).toBeGreaterThanOrEqual(0);
    expect(redirectIdx).toBeGreaterThan(submitIdx);
    expect(host.openedUrls[0]).toBe('https://example.com/next');
  });

  it('type:store_review → calls host.openReview', async () => {
    const host = await submitPositive({ type: 'store_review' });
    expect(host.calls).toContain('submit');
    expect(host.reviewCount).toBe(1);
  });

  it('submit hard-failure shows a retry affordance', async () => {
    const host = makeHost({ submitRejects: true });
    mount(document.body, makeConfig({ positive_action: { type: 'none' } }), host);
    await tick();
    qa<HTMLButtonElement>('.sig-face')
      .find((f) => f.dataset.value === '3')
      ?.click();
    await tick();
    const retry = q<HTMLButtonElement>('.sig-btn-primary');
    expect(retry?.textContent).toBe('Retry');
  });

  it('double-tap a face triggers exactly one submit', async () => {
    const host = makeHost();
    mount(document.body, makeConfig({ positive_action: { type: 'thanks', message: 'ok' } }), host);
    await tick();
    const face = qa<HTMLButtonElement>('.sig-face').find((f) => f.dataset.value === '3');
    face?.click();
    face?.click();
    await tick();
    expect(host.calls.filter((c) => c === 'submit')).toHaveLength(1);
  });
});
