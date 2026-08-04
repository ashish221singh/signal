/**
 * Full-color rating faces (F1-D11, D18). Hand-authored inline SVG so they render
 * IDENTICALLY on every platform — NEVER the system emoji font (which varies per OS
 * and can't be controlled) and NOT monochrome `currentColor` glyphs. Each face is a
 * warm-yellow disc with a subtle darker rim, two dot eyes, and a mouth whose
 * curvature encodes the sentiment (frown / flat / smile).
 *
 * viewBox is a 0..1 unit square so the SVG scales cleanly into whatever tile size
 * the CSS gives it. Colors are baked in (not themed) — these are a brand asset.
 */

const FACE_FILL = '#FFC93C';
const FACE_EDGE = '#E8A93A';
const INK = '#5A4A1E';

/** The yellow disc + rim + eyes, shared by every face. */
const BASE =
  `<circle cx="0.5" cy="0.5" r="0.47" fill="${FACE_FILL}" stroke="${FACE_EDGE}" stroke-width="0.03"/>` +
  `<circle cx="0.35" cy="0.42" r="0.052" fill="${INK}"/>` +
  `<circle cx="0.65" cy="0.42" r="0.052" fill="${INK}"/>`;

function face(mouth: string): string {
  return (
    `<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    BASE +
    mouth +
    `</svg>`
  );
}

const MOUTH = `stroke="${INK}" stroke-width="0.055" fill="none" stroke-linecap="round" stroke-linejoin="round"`;

/** Frown — mouth curves downward (unhappy). */
export const negativeSvg = face(`<path d="M0.34 0.72 Q0.5 0.6 0.66 0.72" ${MOUTH}/>`);
/** Flat — a straight mouth (neutral). */
export const neutralSvg = face(`<path d="M0.35 0.68 L0.65 0.68" ${MOUTH}/>`);
/** Smile — mouth curves upward (happy). */
export const positiveSvg = face(`<path d="M0.34 0.64 Q0.5 0.78 0.66 0.64" ${MOUTH}/>`);

/** In display order (worst → best), 1-based to match the emoji 1..3 scale. */
export const EMOJI_FACES: ReadonlyArray<{ value: number; label: string; svg: string }> = [
  { value: 1, label: 'Unhappy', svg: negativeSvg },
  { value: 2, label: 'Neutral', svg: neutralSvg },
  { value: 3, label: 'Happy', svg: positiveSvg },
];
