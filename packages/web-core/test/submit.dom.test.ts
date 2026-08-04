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

  it('type:thanks → shows the configured message as the bold title, no action button', async () => {
    const host = await submitPositive({ type: 'thanks', message: 'You rock' });
    expect(host.calls).toContain('submit');
    expect(q('.sig-thanks-title')?.textContent).toBe('You rock');
    // thanks has no follow-up affordance.
    expect(q('.sig-thanks-action')).toBeNull();
  });

  it('type:redirect → records, then shows an outlined button that calls host.openUrl on tap', async () => {
    const host = await submitPositive({ type: 'redirect', url: 'https://example.com/next' });
    // Recorded on submit; the redirect is NOT auto-fired.
    expect(host.calls).toContain('submit');
    expect(host.openedUrls).toHaveLength(0);
    const btn = q<HTMLButtonElement>('.sig-thanks-action');
    expect(btn).not.toBeNull();
    btn?.click();
    // Only after the user taps does the host redirect — and submit came first.
    const submitIdx = host.calls.indexOf('submit');
    const redirectIdx = host.calls.findIndex((c) => c.startsWith('openUrl:'));
    expect(redirectIdx).toBeGreaterThan(submitIdx);
    expect(host.openedUrls[0]).toBe('https://example.com/next');
  });

  it('type:store_review → shows an outlined button that calls host.openReview on tap', async () => {
    const host = await submitPositive({ type: 'store_review' });
    expect(host.calls).toContain('submit');
    // Not auto-fired.
    expect(host.reviewCount).toBe(0);
    // The store_review branch shows the standard warm title + subtext (mockup),
    // with the review label riding the outlined button.
    expect(q('.sig-thanks-title')?.textContent).toBe('Thanks — that helps.');
    expect(q('.sig-thanks-sub')?.textContent).toBe(
      'Your feedback goes straight to the product team.',
    );
    const btn = q<HTMLButtonElement>('.sig-thanks-action');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('Rate us');
    btn?.click();
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
