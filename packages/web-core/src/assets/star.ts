/**
 * Star rating glyph (F1 star variant). Hand-authored inline SVG so it renders
 * identically cross-platform. Fill is driven by CSS (`.sig-star` lit/unlit) rather
 * than baked in, since a star's meaning is carried by whether it is filled — the
 * component toggles `fill` via the `--s-line` → `--s-accent` swap in styles.ts.
 *
 * Geometry matches the approved sheet mockup (viewBox 0 0 24 24).
 */
const STAR_PATH =
  'M12 2l2.9 6.26L21.5 9.3l-4.75 4.4 1.2 6.55L12 17l-5.95 3.25 1.2-6.55L2.5 9.3l6.6-1.04z';

export const starSvg =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
  `<path d="${STAR_PATH}"/></svg>`;

/** The 5-point star scale, 1-based (worst → best). */
export const STAR_MAX = 5;
