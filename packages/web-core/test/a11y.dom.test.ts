// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, getShadow, makeConfig, makeHost, media, mount, q, qa, tick } from './helpers.js';

afterEach(cleanup);

describe('accessibility (DOM)', () => {
  it('sheet is a labelled modal dialog with a live region', async () => {
    mount(document.body, makeConfig(), makeHost());
    await tick();
    const dialog = q('.sig-sheet');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('How was your experience?');
    expect(q('[aria-live]')).not.toBeNull();
  });

  it('faces are a labelled radiogroup with text alternatives', async () => {
    mount(document.body, makeConfig(), makeHost());
    await tick();
    expect(q('[role=radiogroup]')).not.toBeNull();
    const faces = qa('.sig-face');
    for (const f of faces) {
      expect(f.getAttribute('role')).toBe('radio');
      expect(f.getAttribute('aria-label')?.length).toBeGreaterThan(0);
    }
  });

  it('Escape dismisses via host.dismiss("esc")', async () => {
    const host = makeHost();
    mount(document.body, makeConfig(), host);
    await tick();
    getShadow()
      .querySelector('.sig-backdrop')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(host.dismissedWith).toContain('esc');
  });

  it('backdrop tap dismisses via host.dismiss("backdrop")', async () => {
    const host = makeHost();
    mount(document.body, makeConfig(), host);
    await tick();
    const backdrop = getShadow().querySelector('.sig-backdrop');
    backdrop?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await tick();
    expect(host.dismissedWith).toContain('backdrop');
  });

  it('config invalid → fail closed: no sheet, host.dismiss("config_invalid")', async () => {
    const host = makeHost();
    // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid
    mount(document.body, makeConfig({ header: '' }) as any, host);
    await tick();
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
    expect(host.dismissedWith).toContain('config_invalid');
  });

  it('a second mount while one is open is a no-op (one sheet at a time)', async () => {
    const host = makeHost();
    mount(document.body, makeConfig(), host);
    await tick();
    mount(document.body, makeConfig(), makeHost());
    await tick();
    expect(document.querySelectorAll('[data-signal-sheet]')).toHaveLength(1);
  });

  it('reduced-motion path tears down synchronously (no lingering timers)', async () => {
    media.reducedMotion = true;
    const host = makeHost();
    const handle = mount(document.body, makeConfig(), host);
    await tick();
    handle.close();
    // synchronous removal under reduced motion
    expect(document.querySelector('[data-signal-sheet]')).toBeNull();
  });
});
