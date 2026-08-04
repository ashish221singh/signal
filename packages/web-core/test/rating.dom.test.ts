// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, getShadow, makeConfig, makeHost, mount, q, qa, tick } from './helpers.js';

afterEach(cleanup);

describe('rating step (DOM)', () => {
  it('renders the question and 3 inline-SVG faces (not font glyphs)', async () => {
    mount(document.body, makeConfig(), makeHost());
    await tick();
    expect(q('.sig-question')?.textContent).toBe('How was your experience?');
    const faces = qa('.sig-face');
    expect(faces).toHaveLength(3);
    // Emoji are hand-authored full-color inline SVG (F1-D11/D18), not text emoji
    // and not monochrome currentColor — so they render identically cross-platform.
    for (const f of faces) {
      const svg = f.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(f.innerHTML).not.toContain('currentColor');
      // The warm-yellow face fill is baked in.
      expect(f.innerHTML).toContain('#FFC93C');
    }
  });

  it('shows the "One tap" hint under the faces', async () => {
    mount(document.body, makeConfig(), makeHost());
    await tick();
    expect(q('.sig-hint')?.textContent).toBe('One tap');
  });

  it('selecting the positive face (threshold 3) routes to submitting → done', async () => {
    const host = makeHost();
    mount(document.body, makeConfig({ positive_action: { type: 'thanks', message: 'Yay' } }), host);
    await tick();
    const positive = qa<HTMLButtonElement>('.sig-face').find((f) => f.dataset.value === '3');
    positive?.click();
    await tick();
    expect(host.calls).toContain('submit');
    expect(q('.sig-thanks-title')?.textContent).toBe('Yay');
  });

  it('selecting a negative face with capture routes to the detail step', async () => {
    mount(document.body, makeConfig({ other_requires_text: true }), makeHost());
    await tick();
    const neg = qa<HTMLButtonElement>('.sig-face').find((f) => f.dataset.value === '1');
    neg?.click();
    await tick();
    expect(q('.sig-textarea')).not.toBeNull();
  });

  it('roving radiogroup: arrow keys move selection with wrap', async () => {
    mount(document.body, makeConfig({ other_requires_text: true }), makeHost());
    await tick();
    const shadow = getShadow();
    const backdrop = shadow.querySelector('.sig-backdrop');
    const faces = qa<HTMLButtonElement>('.sig-face');
    faces[0]?.focus();
    backdrop?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(faces[0]?.getAttribute('aria-checked')).toBe('true');
    backdrop?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    // wrapped left from index 0 → last
    expect(faces[2]?.getAttribute('aria-checked')).toBe('true');
  });
});
