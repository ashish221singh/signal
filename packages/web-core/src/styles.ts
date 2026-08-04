/**
 * Component CSS for the sheet, injected into the shadow root AFTER tokensCss so it
 * can reuse the font-family + motion/ease tokens (F1-D2, D8). Kept as a string
 * (no CSS file, F1-D15).
 *
 * The sheet is a GUEST inside customers' apps, so it ships a self-contained,
 * neutral WHITE/light palette (declared as `--s-*` variables on `:host`) and
 * renders the same regardless of the host's dark/light mode. It does NOT consume
 * Signal's dark brand tokens (`--surface`, `--ink`, …) for color — only the
 * shared `--font-sans` and motion/ease tokens from tokens.css.
 *
 * Responsive: bottom sheet on narrow viewports; a centered floating card at
 * `min-width: 640px` (web-portal friendly). Motion collapses to instant under
 * `prefers-reduced-motion` (tokens zero the motion vars + the rules below).
 */
export const componentCss = `
:host {
  all: initial;
  font-family: var(--font-sans);

  /* ---- self-contained LIGHT palette (generic guest surface) ------------- */
  --s-surface:     #FFFFFF;
  --s-surface-2:   #F7F7F6;
  --s-line:        #E5E4E1;
  --s-line-strong: #D2D1CD;

  --s-ink:         #191815;
  --s-ink-2:       #5B5A55;
  --s-ink-3:       #A8A7A1;

  --s-accent:       #F78200;
  --s-accent-hover: #D96F00;
  --s-accent-tint:  #FFF5EB;
  --s-accent-ink:   #7F4100;

  --s-focus:   #0094DD;
  --s-success: #2E8F52;
  --s-danger:  #CC3D33;

  --s-scrim:   rgba(25, 24, 21, .42);

  --s-radius-sm:  10px;
  --s-radius-md:  15px;
  --s-radius-lg:  20px;
  --s-radius-full: 999px;

  --s-shadow-1:     0 1px 2px rgba(25, 24, 21, .06), 0 1px 3px rgba(25, 24, 21, .05);
  --s-shadow-2:     0 6px 16px rgba(25, 24, 21, .12);
  --s-shadow-sheet: 0 -8px 30px rgba(25, 24, 21, .14);
  --s-shadow-card:  0 20px 48px rgba(25, 24, 21, .22);

  color: var(--s-ink);
}
*, *::before, *::after { box-sizing: border-box; }

.sig-backdrop {
  position: fixed;
  inset: 0;
  background: var(--s-scrim);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 2147483000;
  opacity: 0;
  transition: opacity var(--motion-base) var(--ease-out);
}
.sig-backdrop[data-open='true'] { opacity: 1; }

.sig-sheet {
  position: relative;
  width: 100%;
  max-width: 480px;
  background: var(--s-surface);
  color: var(--s-ink);
  border-radius: var(--s-radius-lg) var(--s-radius-lg) 0 0;
  box-shadow: var(--s-shadow-sheet);
  padding: var(--space-3) var(--space-5) var(--space-5);
  padding-bottom: calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
  transform: translateY(100%);
  transition: transform var(--motion-sheet) var(--ease-sheet);
  max-height: 90vh;
  overflow-y: auto;
}
.sig-backdrop[data-open='true'] .sig-sheet { transform: translateY(0); }

.sig-grabber {
  width: 34px;
  height: 4px;
  border-radius: 2px;
  background: var(--s-line);
  margin: 0 auto var(--space-3);
}

.sig-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.sig-question {
  font: 700 20px/1.2 var(--font-sans);
  color: #191815;
  margin: 0;
  padding-top: 2px;
  letter-spacing: -0.01em;
}
.sig-close {
  flex: none;
  width: 44px;
  height: 44px;
  min-width: 44px;
  border: none;
  background: transparent;
  color: var(--s-ink-2);
  border-radius: var(--s-radius-full);
  cursor: pointer;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
/* The visible target is a 26px circle; the button stays 44px for touch a11y. */
.sig-close::before {
  content: '×';
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #F0F0EE;
  color: #7C7B75;
  font-size: 15px;
  line-height: 24px;
  text-align: center;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.sig-close:hover::before { background: var(--s-line); color: var(--s-ink); }
.sig-close:focus-visible { outline: 2px solid var(--s-focus); outline-offset: 2px; }

/* --- rating step --- */
.sig-faces {
  display: flex;
  gap: var(--space-3);
  justify-content: center;
  margin: var(--space-4) 0 var(--space-2);
}
.sig-face {
  flex: 1;
  min-height: 44px;
  aspect-ratio: 1 / 1;
  max-width: 72px;
  border: 1px solid #E5E4E1;
  background: #FFFFFF;
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(25, 24, 21, .05);
  color: var(--s-ink-2);
  cursor: pointer;
  padding: 14px;
  transition: transform var(--motion-fast) var(--ease-out),
              background var(--motion-fast) var(--ease-out),
              border-color var(--motion-fast) var(--ease-out),
              box-shadow var(--motion-fast) var(--ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sig-face svg { width: 100%; height: 100%; display: block; }
.sig-face:hover { transform: translateY(-2px); box-shadow: 0 6px 14px rgba(25, 24, 21, .10); }
.sig-face[aria-checked='true'] {
  background: #FFF5EB;
  border-color: #F78200;
  box-shadow: 0 0 0 1.5px #F78200;
}
.sig-face:focus-visible { outline: 2px solid var(--s-focus); outline-offset: 2px; }

.sig-hint {
  text-align: center;
  font: 400 12.5px/1.4 var(--font-sans);
  color: #A8A7A1;
  margin: var(--space-2) 0 0;
}

/* --- detail step --- */
.sig-field { margin-top: var(--space-4); }
.sig-label {
  display: block;
  font: 600 13px/1.4 var(--font-sans);
  color: var(--s-ink);
  margin-bottom: var(--space-2);
}
.sig-textarea {
  width: 100%;
  min-height: 78px;
  resize: none;
  font: 400 14px/1.5 var(--font-sans);
  color: var(--s-ink);
  background: var(--s-surface-2);
  border: none;
  border-radius: var(--s-radius-sm);
  box-shadow: var(--s-shadow-1);
  padding: var(--space-3);
  outline: none;
  transition: box-shadow var(--motion-fast) var(--ease-out);
}
.sig-textarea::placeholder { color: var(--s-ink-3); }
.sig-textarea:focus-visible,
.sig-textarea:focus { box-shadow: 0 0 0 1.5px var(--s-focus), 0 2px 6px rgba(0, 148, 221, .12); }
.sig-counter { font: 400 12px/1.4 var(--font-sans); color: var(--s-ink-3); text-align: right; margin-top: var(--space-1); }
.sig-error { color: var(--s-danger); font: 400 12.5px/1.4 var(--font-sans); margin-top: var(--space-2); }

.sig-photo-row { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-2); flex-wrap: wrap; }
.sig-thumb {
  width: 56px; height: 56px; border-radius: var(--s-radius-sm); object-fit: cover;
  border: 1px solid var(--s-line);
}
.sig-hidden-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

/* --- buttons --- */
.sig-actions { margin-top: var(--space-5); display: flex; gap: var(--space-3); }
.sig-btn {
  flex: 1;
  min-height: 44px;
  border-radius: var(--s-radius-sm);
  font: 600 14px/1 var(--font-sans);
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--motion-fast) var(--ease-out),
              box-shadow var(--motion-fast) var(--ease-out),
              opacity var(--motion-fast) var(--ease-out);
}
.sig-btn-primary { background: var(--s-accent); color: #FFFFFF; }
.sig-btn-primary:hover { background: var(--s-accent-hover); }
.sig-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.sig-btn-ghost { background: var(--s-surface); color: var(--s-ink); box-shadow: var(--s-shadow-1); border-color: transparent; }
.sig-btn-ghost:hover { box-shadow: var(--s-shadow-2); }
.sig-btn:focus-visible { outline: 2px solid var(--s-focus); outline-offset: 2px; }

/* --- submitting / done --- */
.sig-center { text-align: center; padding: var(--space-5) 0; }
.sig-spinner {
  width: 32px; height: 32px; margin: 0 auto var(--space-4);
  border: 3px solid var(--s-line);
  border-top-color: var(--s-accent);
  border-radius: var(--s-radius-full);
  animation: sig-spin var(--motion-slow) linear infinite;
}
@keyframes sig-spin { to { transform: rotate(360deg); } }
.sig-done-msg { font: 600 15px/1.4 var(--font-sans); color: var(--s-ink); margin: 0; }

/* --- thanks / done state (reference: pale-green circle + green check) --- */
.sig-thanks { text-align: center; padding: var(--space-5) 0 var(--space-3); }
.sig-check-circle {
  width: 64px;
  height: 64px;
  margin: 0 auto var(--space-4);
  border-radius: 50%;
  background: #E6F4EC;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sig-check-circle svg { width: 30px; height: 30px; display: block; }
.sig-thanks-title { font: 700 16px/1.3 var(--font-sans); color: #191815; margin: 0; }
.sig-thanks-sub { font: 400 13px/1.5 var(--font-sans); color: var(--s-ink-3); margin: var(--space-2) 0 0; }
.sig-thanks-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  margin-top: var(--space-4);
  padding: 0 16px;
  border-radius: 10px;
  border: 1px solid #E5E4E1;
  background: #FFFFFF;
  color: var(--s-ink);
  font: 600 13.5px/1 var(--font-sans);
  cursor: pointer;
  transition: box-shadow var(--motion-fast) var(--ease-out),
              border-color var(--motion-fast) var(--ease-out);
}
.sig-thanks-action:hover { box-shadow: 0 2px 8px rgba(25, 24, 21, .10); border-color: var(--s-line-strong); }
.sig-thanks-action:focus-visible { outline: 2px solid var(--s-focus); outline-offset: 2px; }

.sig-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.sig-branch { transition: opacity var(--motion-base) var(--ease-out); }

/* ---- Desktop / web-portal: centered floating card (F1 responsive) ------- */
@media (min-width: 640px) {
  .sig-backdrop { align-items: center; }
  .sig-sheet {
    max-width: 400px;
    border-radius: var(--s-radius-lg);
    box-shadow: var(--s-shadow-card);
    transform: translateY(8px) scale(.96);
    opacity: 0;
    transition: transform var(--motion-base) var(--ease-out),
                opacity var(--motion-base) var(--ease-out);
    padding-top: var(--space-5);
  }
  .sig-backdrop[data-open='true'] .sig-sheet { transform: none; opacity: 1; }
  .sig-grabber { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .sig-spinner { animation: none; }
  .sig-backdrop, .sig-sheet, .sig-face, .sig-close, .sig-btn, .sig-textarea, .sig-thanks-action { transition: none; }
}
`;
