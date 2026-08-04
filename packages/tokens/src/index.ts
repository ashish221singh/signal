/**
 * @signal/tokens — the canonical Signal design tokens (F1-D17).
 *
 * The raw file lives at `packages/tokens/tokens.css` and is the single source of
 * truth; the styleguide `<link>`s it directly. Code consumers (web-core, later
 * shells + hosted link) import the `tokensCss` string below, which has the
 * self-hosted subset fonts inlined as data-URI @font-face rules (F1-D19) so it is
 * fully portable into a shadow root with zero runtime font fetches.
 */
export { fontFaceCss, tokensCss } from './generated.js';

/** Font families shipped as subset woff2 in this package (F1-D19). */
export const FONT_FILES = [
  'jetbrains-mono-400.woff2',
  'jetbrains-mono-500.woff2',
  'jetbrains-mono-600.woff2',
  'inter-400.woff2',
  'inter-500.woff2',
  'inter-600.woff2',
  'schibsted-grotesk-400.woff2',
  'schibsted-grotesk-600.woff2',
  'schibsted-grotesk-700.woff2',
] as const;
