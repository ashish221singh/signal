import { gzipSync } from 'node:zlib';
import { fontFaceCss, tokensCss } from '@signal/tokens';
import { describe, expect, it } from 'vitest';
import { componentCss } from '../src/styles.js';

describe('bundle budget hygiene (F1-D15)', () => {
  it('tokensCss carries NO font bytes (fonts are split out)', () => {
    expect(tokensCss).not.toContain('data:font/woff2;base64,');
    expect(tokensCss).toContain('--action'); // still the real token file
  });

  it('fontFaceCss carries the self-hosted data-URI fonts (F1-D19)', () => {
    expect(fontFaceCss).toContain('@font-face');
    expect(fontFaceCss).toContain('data:font/woff2;base64,');
    expect(fontFaceCss).toContain('JetBrains Mono');
    expect(fontFaceCss).toContain('Inter');
    expect(fontFaceCss).toContain('font-display: swap');
  });

  it('token CSS + component CSS gzip is comfortably inside the 35KB core budget', () => {
    const core = `${tokensCss}\n${componentCss}`;
    const gz = gzipSync(Buffer.from(core)).length;
    expect(gz).toBeLessThan(35 * 1024);
  });
});
