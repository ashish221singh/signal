import type { SheetHandle, SheetHost } from '../src/host.js';
import { mount as coreMount } from '../src/mount.js';
import type { WorkflowConfig } from '../src/types.js';

// happy-dom has no matchMedia. Provide a controllable stub so tests are
// deterministic: reduced-motion ON by default (instant teardown, no timers) and
// dark theme (prefers-color-scheme: light = false). Individual tests can override.
interface MediaState {
  reducedMotion: boolean;
  light: boolean;
}
export const media: MediaState = { reducedMotion: true, light: false };

if (typeof window !== 'undefined') {
  // Always override — happy-dom ships a matchMedia that returns matches:false,
  // which would force the timer-based teardown path and slow/flake tests.
  // biome-ignore lint/suspicious/noExplicitAny: minimal MediaQueryList stub
  (window as any).matchMedia = (query: string) => {
    const matches =
      /prefers-reduced-motion/.test(query) && !/no-preference/.test(query)
        ? media.reducedMotion
        : /prefers-color-scheme:\s*light/.test(query)
          ? media.light
          : false;
    return {
      matches,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent() {
        return false;
      },
    };
  };
  // sheet.ts reads the bare global `matchMedia`; keep them in sync.
  // biome-ignore lint/suspicious/noExplicitAny: mirror onto globalThis
  (globalThis as any).matchMedia = (window as any).matchMedia;
}

let lastHandle: SheetHandle | null = null;

/** Mount wrapper for tests that remembers the handle so cleanup can close it
 *  (and thereby clear the one-sheet-at-a-time singleton between tests). */
export function mount(root: HTMLElement, config: WorkflowConfig, host: SheetHost): SheetHandle {
  lastHandle = coreMount(root, config, host);
  return lastHandle;
}

/** Force-close any open sheet and flush its teardown so `active` is cleared. */
export async function cleanup(): Promise<void> {
  lastHandle?.close();
  lastHandle = null;
  // With reduced-motion stubbed on, teardown removes synchronously; flush any
  // pending microtasks just in case, then hard-remove.
  await new Promise((r) => setTimeout(r, 0));
  document.querySelector('[data-signal-sheet]')?.remove();
  document.body.innerHTML = '';
}

export function makeConfig(over: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    trigger_id: '11111111-1111-1111-1111-111111111111',
    campaign_id: '22222222-2222-2222-2222-222222222222',
    metric_type: 'CSAT',
    header: 'How was your experience?',
    rating_type: 'emoji',
    rating_scale_max: 3,
    positive_threshold: 3,
    chips_on_negative: [],
    other_requires_text: false,
    other_allows_image: false,
    positive_action: { type: 'none' },
    negative_action: { type: 'none' },
    skip_enabled: false,
    ...over,
  } as WorkflowConfig;
}

export interface MockHost extends SheetHost {
  calls: string[];
  submitted: unknown[];
  dismissedWith: string[];
  openedUrls: string[];
  reviewCount: number;
}

export function makeHost(
  opts: { submitRejects?: boolean; uploadRejects?: boolean } = {},
): MockHost {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  const dismissedWith: string[] = [];
  const openedUrls: string[] = [];
  const host: MockHost = {
    calls,
    submitted,
    dismissedWith,
    openedUrls,
    reviewCount: 0,
    async submit(answer) {
      calls.push('submit');
      submitted.push(answer);
      if (opts.submitRejects) throw new Error('submit failed');
    },
    dismiss(reason) {
      calls.push(`dismiss:${reason}`);
      dismissedWith.push(reason);
    },
    async requestUpload(_file) {
      calls.push('requestUpload');
      if (opts.uploadRejects) throw new Error('upload failed');
      return 'https://cdn.example.com/photo.jpg';
    },
    openReview() {
      calls.push('openReview');
      host.reviewCount += 1;
    },
    openUrl(url) {
      calls.push(`openUrl:${url}`);
      openedUrls.push(url);
    },
  };
  return host;
}

/** Query the sheet's shadow root (the sheet host element carries data-signal-sheet). */
export function getShadow(): ShadowRoot {
  const el = document.querySelector('[data-signal-sheet]');
  if (!el?.shadowRoot) throw new Error('no sheet mounted');
  return el.shadowRoot;
}

export function q<T extends Element = HTMLElement>(sel: string): T | null {
  return getShadow().querySelector<T>(sel);
}

export function qa<T extends Element = HTMLElement>(sel: string): T[] {
  return Array.from(getShadow().querySelectorAll<T>(sel));
}

/** Flush microtasks + a rAF tick (mount opens on rAF). */
export async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  await new Promise((r) => setTimeout(r, 0));
}
