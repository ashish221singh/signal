/**
 * mount() — the public entry (F1). Creates a Shadow DOM host, injects tokensCss
 * (F1-D2) + component CSS, validates the config fail-closed (F1-D10), and drives
 * the SheetView. The sheet is a guest in customers' apps so it ships a
 * self-contained neutral WHITE surface (see styles.ts) and renders the same
 * regardless of the host's dark/light mode. One sheet at a time (F1-D13): a
 * second mount while one is open is a no-op returning the existing handle.
 */
import { fontFaceCss, tokensCss } from '@signal/tokens';
import { normalizeConfig } from './config.js';
import type { SheetHandle, SheetHost } from './host.js';
import { SheetView } from './sheet.js';
import { componentCss } from './styles.js';
import type { WorkflowConfig } from './types.js';

let active: SheetHandle | null = null;

export function mount(root: HTMLElement, config: WorkflowConfig, host: SheetHost): SheetHandle {
  // One sheet at a time (F1-D13).
  if (active) return active;

  const result = normalizeConfig(config);
  if (!result.ok) {
    // Fail closed: never render a broken sheet. Report and dismiss.
    if (typeof console !== 'undefined') {
      console.warn(`[signal] config invalid, not mounting: ${result.reason}`);
    }
    host.dismiss('config_invalid');
    return { close() {} };
  }

  const hostEl = document.createElement('div');
  hostEl.setAttribute('data-signal-sheet', '');
  const shadow = hostEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  // tokensCss (vars/theme) + componentCss (sheet) are the "core"; fontFaceCss
  // carries the self-hosted data-URI fonts (F1-D19), injected but excluded from
  // the core size budget (F1-D15).
  style.textContent = `${fontFaceCss}\n${tokensCss}\n${componentCss}`;
  shadow.appendChild(style);

  root.appendChild(hostEl);

  const view = new SheetView(shadow, result.config, host, {
    onTeardown() {
      hostEl.remove();
      if (active === handle) active = null;
    },
  });

  const handle: SheetHandle = {
    close() {
      view.close('handle');
    },
  };

  active = handle;
  return handle;
}
