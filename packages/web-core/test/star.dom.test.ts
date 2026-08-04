// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, getShadow, makeConfig, makeHost, mount, q, qa, tick } from './helpers.js';

afterEach(cleanup);

describe('star rating variant (DOM)', () => {
  it('renders 5 star buttons with the star hint when rating_type=star', async () => {
    mount(document.body, makeConfig({ rating_type: 'star', rating_scale_max: 5 }), makeHost());
    await tick();
    const stars = qa('.sig-star');
    expect(stars).toHaveLength(5);
    // Emoji tiles are not used in the star variant.
    expect(qa('.sig-face')).toHaveLength(0);
    expect(q('.sig-hint')?.textContent).toBe("Tap a star — one tap, that's it");
  });

  it('stars are a labelled radiogroup with per-star text alternatives', async () => {
    mount(document.body, makeConfig({ rating_type: 'star', rating_scale_max: 5 }), makeHost());
    await tick();
    expect(q('[role=radiogroup]')).not.toBeNull();
    const stars = qa('.sig-star');
    expect(stars[0]?.getAttribute('aria-label')).toBe('1 star');
    expect(stars[4]?.getAttribute('aria-label')).toBe('5 stars');
    for (const s of stars) expect(s.getAttribute('role')).toBe('radio');
  });

  it('tapping a star lights every star up to it and records the 1-based value', async () => {
    const host = makeHost();
    mount(
      document.body,
      makeConfig({
        rating_type: 'star',
        rating_scale_max: 5,
        positive_threshold: 4,
        positive_action: { type: 'thanks', message: 'Cheers' },
      }),
      host,
    );
    await tick();
    const stars = qa<HTMLButtonElement>('.sig-star');
    // 4 stars = positive (>= threshold 4) → straight to submit → thanks.
    stars[3]?.click();
    await tick();
    expect(host.calls).toContain('submit');
    const answer = host.submitted[0] as { rating_value: number; positive: boolean };
    expect(answer.rating_value).toBe(4);
    expect(answer.positive).toBe(true);
    expect(q('.sig-thanks-title')?.textContent).toBe('Cheers');
  });

  it('a low star rating routes to the negative detail step', async () => {
    mount(
      document.body,
      makeConfig({
        rating_type: 'star',
        rating_scale_max: 5,
        positive_threshold: 4,
        other_requires_text: true,
      }),
      makeHost(),
    );
    await tick();
    qa<HTMLButtonElement>('.sig-star')[0]?.click(); // 1 star → negative
    await tick();
    expect(q('.sig-textarea')).not.toBeNull();
    expect(q('.sig-question')?.textContent).toBe('Tell us what happened');
  });

  it('arrow keys move the lit selection with wrap', async () => {
    mount(document.body, makeConfig({ rating_type: 'star', rating_scale_max: 5 }), makeHost());
    await tick();
    const backdrop = getShadow().querySelector('.sig-backdrop');
    const stars = qa<HTMLButtonElement>('.sig-star');
    stars[0]?.focus();
    backdrop?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(stars[0]?.getAttribute('aria-checked')).toBe('true');
    backdrop?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    // wrapped left from index 0 → last (5 stars lit)
    expect(stars[4]?.getAttribute('aria-checked')).toBe('true');
    expect(stars[4]?.classList.contains('sig-star-lit')).toBe(true);
  });
});
