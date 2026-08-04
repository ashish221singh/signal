/**
 * SheetHost — the impure boundary (F1-D3). The core NEVER calls the network; it
 * only invokes these host callbacks. On web these are direct function calls; on
 * native the same intents cross the bridge as JSON messages (see
 * docs/sheet-bridge-v1.md).
 */
import type { Answer } from './types.js';

/** Why the sheet closed. `config_invalid` is a fail-closed dismissal that never
 *  showed a broken sheet (edge case: malformed/missing required config). */
export type DismissReason = 'swipe' | 'backdrop' | 'esc' | 'back' | 'config_invalid';

export interface SheetHost {
  /** Record the response; resolves when persisted/queued (the outbox lives in the
   *  shell, F2). A rejection is a hard failure ⇒ the core shows a retry. */
  submit(answer: Answer): Promise<void>;
  /** The sheet was dismissed without a submit. */
  dismiss(reason: DismissReason): void;
  /** Upload an attached image; resolves to the stored URL. The host owns presign
   *  + PUT. A rejection lets the user submit text-only (never blocks the answer). */
  requestUpload(file: File): Promise<string>;
  /** Ask for a native in-app store review (post-submit `store_review`). */
  openReview(): void;
  /** Redirect the user to a URL (post-submit `redirect`). Host decides tab/in-app. */
  openUrl(url: string): void;
  /** Native shells size the WebView to the sheet's measured height. */
  onResize?(height: number): void;
}

/** The handle `mount` returns; lets the embedder force-close the sheet. */
export interface SheetHandle {
  close(): void;
}
