// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeConfig, makeHost, mount, q, qa, tick } from './helpers.js';

afterEach(cleanup);

function goNegative(host = makeHost(), over = {}) {
  const config = makeConfig({ other_requires_text: false, other_allows_image: false, ...over });
  mount(document.body, config, host);
  return host;
}

async function pickNegative(): Promise<void> {
  await tick();
  const neg = qa<HTMLButtonElement>('.sig-face').find((f) => f.dataset.value === '1');
  neg?.click();
  await tick();
}

describe('negative detail step (DOM)', () => {
  it('uses the fixed "Tell us what happened" header and the warm placeholder', async () => {
    goNegative(makeHost(), { other_requires_text: true, other_allows_image: true });
    await pickNegative();
    expect(q('.sig-question')?.textContent).toBe('Tell us what happened');
    const ta = q<HTMLTextAreaElement>('.sig-textarea');
    expect(ta?.placeholder).toBe('A sentence is plenty…');
    // The photo affordance is a dashed clickable strip (paperclip + "Add a photo · optional").
    const photo = q('.sig-photo');
    expect(photo?.textContent).toContain('Add a photo');
    expect(q('.sig-photo-optional')?.textContent).toBe('· optional');
  });

  it('required comment blocks submit; whitespace-only stays blocked', async () => {
    const host = goNegative(makeHost(), { other_requires_text: true });
    await pickNegative();
    const submit = q<HTMLButtonElement>('.sig-btn-primary');
    expect(submit?.disabled).toBe(true);

    const ta = q<HTMLTextAreaElement>('.sig-textarea');
    if (!ta) throw new Error('no textarea');
    ta.value = '   \n ';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit?.disabled).toBe(true);

    ta.value = 'It crashed on save';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit?.disabled).toBe(false);

    submit?.click();
    await tick();
    expect(host.calls).toContain('submit');
    const answer = host.submitted[0] as { other_text?: string };
    expect(answer.other_text).toBe('It crashed on save');
  });

  it('optional comment allows immediate submit', async () => {
    goNegative(makeHost(), { other_requires_text: false, other_allows_image: true });
    await pickNegative();
    const submit = q<HTMLButtonElement>('.sig-btn-primary');
    expect(submit?.disabled).toBe(false);
  });

  it('renders reason chips and rides the selection on the answer', async () => {
    const host = goNegative(makeHost(), {
      chips_on_negative: ['Too slow', 'Confusing', 'Missing data'],
    });
    await pickNegative();
    const chips = qa<HTMLButtonElement>('.sig-chip');
    expect(chips.map((c) => c.textContent)).toEqual(['Too slow', 'Confusing', 'Missing data']);

    // No required comment ⇒ can submit with just a chip.
    const submit = q<HTMLButtonElement>('.sig-btn-primary');
    expect(submit?.disabled).toBe(false);

    chips[1]?.click(); // "Confusing"
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('true');
    submit?.click();
    await tick();
    const answer = host.submitted[0] as { chip_selected?: string };
    expect(answer.chip_selected).toBe('Confusing');
  });

  it('chips are single-select; re-tapping the selected chip clears it', async () => {
    const host = goNegative(makeHost(), { chips_on_negative: ['A', 'B'] });
    await pickNegative();
    const chips = qa<HTMLButtonElement>('.sig-chip');
    chips[0]?.click();
    chips[1]?.click(); // switching selection clears A
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('true');
    chips[1]?.click(); // re-tap clears B
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('false');
    q<HTMLButtonElement>('.sig-btn-primary')?.click();
    await tick();
    const answer = host.submitted[0] as { chip_selected?: string };
    expect(answer.chip_selected).toBeUndefined();
  });

  it('photo attach calls host.requestUpload, shows a thumbnail, and rides the answer', async () => {
    const host = goNegative(makeHost(), { other_allows_image: true });
    await pickNegative();
    const input = q<HTMLInputElement>('input[type=file]');
    if (!input) throw new Error('no file input');
    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(host.calls).toContain('requestUpload');
    const thumb = q<HTMLImageElement>('.sig-thumb');
    expect(thumb?.hidden).toBe(false);

    q<HTMLButtonElement>('.sig-btn-primary')?.click();
    await tick();
    const answer = host.submitted[0] as { other_image_url?: string };
    expect(answer.other_image_url).toBe('https://cdn.example.com/photo.jpg');
  });

  it('rejects a disallowed image type', async () => {
    const host = goNegative(makeHost(), { other_allows_image: true });
    await pickNegative();
    const input = q<HTMLInputElement>('input[type=file]');
    if (!input) throw new Error('no file input');
    const gif = new File([new Uint8Array([1])], 'x.gif', { type: 'image/gif' });
    Object.defineProperty(input, 'files', { value: [gif], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(host.calls).not.toContain('requestUpload');
    expect(q('.sig-photo-status')?.textContent).toMatch(/JPG, PNG, or WebP/);
  });

  it('upload failure lets the user still submit text-only (F1-D7)', async () => {
    const host = goNegative(makeHost({ uploadRejects: true }), {
      other_allows_image: true,
      other_requires_text: false,
    });
    await pickNegative();
    const input = q<HTMLInputElement>('input[type=file]');
    if (!input) throw new Error('no file input');
    const file = new File([new Uint8Array([1, 2, 3])], 'p.webp', { type: 'image/webp' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(host.calls).toContain('requestUpload');
    const submit = q<HTMLButtonElement>('.sig-btn-primary');
    expect(submit?.disabled).toBe(false); // not blocked on the failed image
    submit?.click();
    await tick();
    expect(host.calls).toContain('submit');
    const answer = host.submitted[0] as { other_image_url?: string };
    expect(answer.other_image_url).toBeUndefined();
  });
});
