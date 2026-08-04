/**
 * The web `SheetHost` (F2-D2). web-core is pure and delegates every impure intent
 * here. This host owns transport:
 *  - `submit`  → map the transport-agnostic Answer onto the wire ResponseBody and
 *                enqueue it to the durable outbox, then resolve (queued == success).
 *  - `dismiss` → enqueue a dismiss record to the same outbox.
 *  - `requestUpload` → presign via `/v1/sdk/uploads`, PUT the file, return the
 *                stored URL; on failure throw so the sheet submits text-only (F1/GR-3).
 *  - `openUrl` → window.open (post-submit redirect).
 *  - `openReview` → no store on web → log + no-op (graceful, per sheet-bridge-v1).
 */
import type { UploadTicket } from '@signal/contracts';
import type { Answer, DismissReason, SheetHost } from '@signal/web-core';
import { debug } from './log.js';
import type { Outbox } from './outbox.js';
import { markSuppressed } from './suppression.js';

export interface WebHostContext {
  apiUrl: string;
  publishableKey: string;
  outbox: Outbox;
  /** The subject id (host userId or the persisted anon id) for suppression. */
  userId: string;
  /** The originating event name, for local suppression on close. */
  eventName: string;
  /** The server trigger_id from the eligibility config, for the dismiss report. */
  triggerId: string;
  /** When the sheet was shown (ISO), for shown_at/responded_at. */
  shownAt: string;
  sessionAgeDays?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const DEVICE_OS = 'web';
// A single, stable app_version for the web SDK surface. Bumped with the package.
const APP_VERSION = '@signal/web@0.1.0';

export function createWebHost(ctx: WebHostContext): SheetHost {
  const now = ctx.now ?? (() => Date.now());
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch?.bind(globalThis);

  return {
    async submit(answer: Answer): Promise<void> {
      const responded = new Date(now()).toISOString();
      // Map web-core's Answer → the B1 ResponseBody wire shape. Fields the shell
      // owns (device/app/session/timestamps) are added here.
      const body = {
        trigger_id: answer.trigger_id,
        rating_value: answer.rating_value,
        other_text: answer.other_text ?? null,
        other_image_url: answer.other_image_url ?? null,
        device_os: DEVICE_OS,
        app_version: APP_VERSION,
        session_age_days: ctx.sessionAgeDays ?? null,
        shown_at: ctx.shownAt,
        responded_at: responded,
      };
      await ctx.outbox.enqueue('response', body);
      // Local suppression short-circuit for subsequent tracks this session (F2-D11).
      markSuppressed(ctx.userId, ctx.eventName);
    },

    dismiss(reason: DismissReason): void {
      // `config_invalid` fires before a real sheet ever showed (fail-closed) — there
      // is no server trigger to report, so we only log it and skip the outbox.
      if (reason === 'config_invalid') {
        debug('sheet not shown (config_invalid), nothing to report');
        return;
      }
      // Fire-and-forget: enqueue a dismiss to the same durable outbox.
      const dismissed = new Date(now()).toISOString();
      void ctx.outbox.enqueue('dismiss', {
        trigger_id: ctx.triggerId,
        shown_at: ctx.shownAt,
        dismissed_at: dismissed,
      });
      // Suppress locally on dismiss too (a shorter server cooldown still applies).
      markSuppressed(ctx.userId, ctx.eventName);
    },

    async requestUpload(file: File): Promise<string> {
      if (!fetchImpl) throw new Error('fetch unavailable');
      const contentType = file.type;
      const presignRes = await fetchImpl(`${ctx.apiUrl.replace(/\/$/, '')}/v1/sdk/uploads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Signal-App-Key': ctx.publishableKey,
        },
        body: JSON.stringify({ content_type: contentType }),
      });
      if (!presignRes.ok) throw new Error(`presign failed: ${presignRes.status}`);
      const ticket = (await presignRes.json()) as UploadTicket;
      const put = await fetchImpl(ticket.upload_url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: file,
      });
      if (!put.ok) throw new Error(`upload PUT failed: ${put.status}`);
      return ticket.object_url;
    },

    openUrl(url: string): void {
      try {
        globalThis.open?.(url, '_blank', 'noopener');
      } catch (err) {
        debug('openUrl failed', err);
      }
    },

    openReview(): void {
      // No native store on web (F2-D2 / sheet-bridge-v1): graceful no-op.
      debug('openReview is a no-op on web');
    },
  };
}
