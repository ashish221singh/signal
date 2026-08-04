// @vitest-environment happy-dom
// Smoke test the BUILT bundle (the artifact shells ship) end to end, proving the
// demo's import path works and the sheet mounts with tokens + fonts injected.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import './helpers.js'; // installs the matchMedia stub

// Resolve the built artifact from the package root (cwd is the monorepo root
// under vitest; the file lives at packages/web-core/dist/web-core.mjs).
const distPath = resolve(process.cwd(), 'packages/web-core/dist/web-core.mjs');
const built = existsSync(distPath);
const distUrl = { href: pathToFileURL(distPath).href };

afterEach(() => {
  document.querySelector('[data-signal-sheet]')?.remove();
  document.body.innerHTML = '';
});

describe.skipIf(!built)('built bundle smoke', () => {
  it('mounts from the dist ESM with tokens + fonts injected', async () => {
    const mod = await import(/* @vite-ignore */ distUrl.href);
    const host = {
      submit: async () => {},
      dismiss: () => {},
      requestUpload: async () => 'u',
      openReview: () => {},
      openUrl: () => {},
    };
    const cfg = {
      trigger_id: 't',
      campaign_id: 'c',
      metric_type: 'CSAT',
      header: 'Built?',
      rating_type: 'emoji',
      rating_scale_max: 3,
      positive_threshold: 3,
      chips_on_negative: [],
      other_requires_text: false,
      other_allows_image: false,
      positive_action: { type: 'thanks', message: 'ok' },
      negative_action: { type: 'none' },
      skip_enabled: false,
    };
    mod.mount(document.body, cfg, host);
    await new Promise((r) => setTimeout(r, 10));
    const shadow = document.querySelector('[data-signal-sheet]')?.shadowRoot;
    expect(shadow?.querySelectorAll('.sig-face')).toHaveLength(3);
    const style = shadow?.querySelector('style')?.textContent ?? '';
    expect(style).toContain('data:font/woff2;base64,'); // fonts injected
    expect(style).toContain('--action'); // tokens injected
  });
});
