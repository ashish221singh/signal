/**
 * Full-color rating faces (F1-D11, D18). Hand-authored inline SVG so they render
 * IDENTICALLY on every platform — NEVER the system emoji font (which varies per OS
 * and can't be controlled) and NOT monochrome `currentColor` glyphs. Each face is a
 * warm-yellow disc with a subtle darker rim, two dot eyes, and a mouth whose
 * curvature encodes the sentiment (frown / flat / smile).
 *
 * Geometry + colours match the approved sheet mockup EXACTLY (viewBox 0 0 48 48,
 * `#FFC93C` fill / `#E8A93A` rim, `#5a4a1e` ink). Colours are baked in (not themed)
 * — these are a brand asset.
 */

const FACE_FILL = '#FFC93C';
const FACE_EDGE = '#E8A93A';
const INK = '#5a4a1e';

/** The yellow disc + rim + eyes, shared by every face. */
const BASE =
  `<circle cx="24" cy="24" r="21" fill="${FACE_FILL}" stroke="${FACE_EDGE}" stroke-width="1.5"/>` +
  `<circle cx="17" cy="20" r="2.4" fill="${INK}"/>` +
  `<circle cx="31" cy="20" r="2.4" fill="${INK}"/>`;

function face(mouth: string): string {
  return (
    `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    BASE +
    mouth +
    `</svg>`
  );
}

const MOUTH = `fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"`;

/** Frown — mouth curves downward (unhappy). */
export const negativeSvg = face(`<path d="M16 33 Q24 27 32 33" ${MOUTH}/>`);
/** Flat — a straight mouth (neutral). */
export const neutralSvg = face(`<path d="M16 31 H32" ${MOUTH}/>`);
/** Smile — mouth curves upward (happy). */
export const positiveSvg = face(`<path d="M16 29 Q24 37 32 29" ${MOUTH}/>`);

/** In display order (worst → best), 1-based to match the emoji 1..3 scale. */
export const EMOJI_FACES: ReadonlyArray<{ value: number; label: string; svg: string }> = [
  { value: 1, label: 'Unhappy', svg: negativeSvg },
  { value: 2, label: 'Neutral', svg: neutralSvg },
  { value: 3, label: 'Happy', svg: positiveSvg },
];
