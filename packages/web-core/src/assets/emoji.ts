/**
 * Brand-style rating faces (F1-D11, D18). Hand-authored inline SVG, monochrome via
 * `currentColor` so they theme with tokens and animate — NEVER the platform emoji
 * font (which renders differently per OS and can't be themed). Geometric, terminal
 * feel to match the JetBrains-Mono brand: a round head, two dot eyes, a mouth whose
 * curvature encodes the sentiment.
 *
 * viewBox is 0 0 48 48. `stroke="currentColor"` + `fill="currentColor"` for the
 * eyes; the mouth is a stroked path. All strokes are round-capped.
 */

const HEAD =
  '<circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="2.5"/>';
const EYES =
  '<circle cx="17" cy="20" r="2.4" fill="currentColor"/><circle cx="31" cy="20" r="2.4" fill="currentColor"/>';

function face(mouthPath: string): string {
  return (
    `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    HEAD +
    EYES +
    `<path d="${mouthPath}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

/** Frown — mouth curves downward. */
export const negativeSvg = face('M15 34 Q24 27 33 34');
/** Flat — a straight mouth. */
export const neutralSvg = face('M15 32 L33 32');
/** Smile — mouth curves upward. */
export const positiveSvg = face('M15 30 Q24 37 33 30');

/** In display order (worst → best), 1-based to match the emoji 1..3 scale. */
export const EMOJI_FACES: ReadonlyArray<{ value: number; label: string; svg: string }> = [
  { value: 1, label: 'Unhappy', svg: negativeSvg },
  { value: 2, label: 'Neutral', svg: neutralSvg },
  { value: 3, label: 'Happy', svg: positiveSvg },
];
