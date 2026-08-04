/**
 * Component CSS for the sheet, injected into the shadow root AFTER tokensCss so it
 * consumes the design tokens (F1-D2, D8). Kept as a string (no CSS file, F1-D15).
 * Dark is the token default; light is opt-in via `.theme-light` which mount.ts
 * toggles from `prefers-color-scheme` (F1-D9). Motion uses the motion/ease tokens
 * and collapses to instant under `prefers-reduced-motion` (already in tokens.css).
 */
export const componentCss = `
:host {
  all: initial;
  font-family: var(--font-sans);
  color: var(--ink);
}
*, *::before, *::after { box-sizing: border-box; }

.sig-backdrop {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 2147483000;
  opacity: 0;
  transition: opacity var(--motion-base) var(--ease-out);
}
.sig-backdrop[data-open='true'] { opacity: 1; }

.sig-sheet {
  width: 100%;
  max-width: 480px;
  background: var(--surface);
  color: var(--ink);
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0;
  box-shadow: var(--shadow-2);
  padding: var(--space-6);
  padding-bottom: calc(var(--space-6) + env(safe-area-inset-bottom, 0px));
  border: 1px solid var(--line);
  border-bottom: none;
  transform: translateY(100%);
  transition: transform var(--motion-sheet) var(--ease-sheet);
  max-height: 90vh;
  overflow-y: auto;
}
.sig-backdrop[data-open='true'] .sig-sheet { transform: translateY(0); }

.sig-grabber {
  width: 40px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  margin: 0 auto var(--space-4);
}

.sig-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}
.sig-question {
  font: var(--text-h3);
  color: var(--ink);
  margin: 0;
}
.sig-close {
  flex: none;
  width: 44px;
  height: 44px;
  min-width: 44px;
  border: none;
  background: transparent;
  color: var(--ink-secondary);
  border-radius: var(--radius-full);
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sig-close:hover { color: var(--ink); background: var(--surface-2); }
.sig-close:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* --- rating step --- */
.sig-faces {
  display: flex;
  gap: var(--space-3);
  justify-content: center;
}
.sig-face {
  flex: 1;
  min-height: 44px;
  aspect-ratio: 1 / 1;
  max-width: 96px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  border-radius: var(--radius-lg);
  color: var(--ink-secondary);
  cursor: pointer;
  padding: var(--space-3);
  transition: transform var(--motion-fast) var(--ease-out),
              color var(--motion-fast) var(--ease-out),
              border-color var(--motion-fast) var(--ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sig-face svg { width: 100%; height: 100%; display: block; }
.sig-face:hover { color: var(--ink); transform: translateY(-2px); }
.sig-face[aria-checked='true'] {
  color: var(--action);
  border-color: var(--action);
}
.sig-face:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* --- detail step --- */
.sig-field { margin-top: var(--space-4); }
.sig-label {
  display: block;
  font: var(--text-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--ink-tertiary);
  margin-bottom: var(--space-2);
}
.sig-textarea {
  width: 100%;
  min-height: 88px;
  resize: none;
  font: var(--text-body);
  color: var(--ink);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}
.sig-textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-color: var(--action); }
.sig-counter { font: var(--text-small); color: var(--ink-tertiary); text-align: right; margin-top: var(--space-1); }
.sig-error { color: var(--danger); font: var(--text-small); margin-top: var(--space-2); }

.sig-photo-row { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-2); flex-wrap: wrap; }
.sig-thumb {
  width: 56px; height: 56px; border-radius: var(--radius-md); object-fit: cover;
  border: 1px solid var(--line);
}
.sig-hidden-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

/* --- buttons --- */
.sig-actions { margin-top: var(--space-6); display: flex; gap: var(--space-3); }
.sig-btn {
  flex: 1;
  min-height: 44px;
  border-radius: var(--radius-md);
  font: var(--text-body);
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out);
}
.sig-btn-primary { background: var(--action); color: var(--action-ink); }
.sig-btn-primary:hover { background: var(--action-hover); }
.sig-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.sig-btn-ghost { background: transparent; color: var(--ink-secondary); border-color: var(--line); }
.sig-btn-ghost:hover { color: var(--ink); background: var(--surface-2); }
.sig-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* --- submitting / done --- */
.sig-center { text-align: center; padding: var(--space-6) 0; }
.sig-spinner {
  width: 32px; height: 32px; margin: 0 auto var(--space-4);
  border: 3px solid var(--line-strong);
  border-top-color: var(--action);
  border-radius: var(--radius-full);
  animation: sig-spin var(--motion-slow) linear infinite;
}
@keyframes sig-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .sig-spinner { animation: none; }
  .sig-backdrop, .sig-sheet, .sig-face { transition: none; }
}
.sig-done-msg { font: var(--text-body-lg); color: var(--ink); margin: 0; }
.sig-check { color: var(--success); font-size: 40px; line-height: 1; margin-bottom: var(--space-3); }

.sig-visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.sig-branch { transition: opacity var(--motion-base) var(--ease-out); }
`;
