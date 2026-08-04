import { z } from 'zod';

/**
 * Post-submit actions (B5). A workflow carries two independent, branchable actions
 * — one for a positive rating (>= positive_threshold) and one for a negative rating
 * — each a small tagged shape `{ type, message?, url? }`:
 *
 * - `none`          — do nothing (just close the sheet).
 * - `thanks`        — show a thank-you message (a default is applied if none given).
 * - `redirect`      — send the user to an https URL (B5-D2: https-only, well-formed).
 * - `store_review`  — ask for an app-store review; the host shell decides how (and
 *                     falls back to `thanks`/close where no store exists, e.g. web).
 *
 * Validation (B5-D2) is enforced at the contract boundary and re-checked at publish:
 * a `redirect` must carry a valid `https://` url; `store_review`/`none` drop any
 * stray `message`/`url` (agents can be sloppy); an unknown `type` is rejected.
 */
export const actionTypeSchema = z.enum(['none', 'thanks', 'redirect', 'store_review']);
export type ActionType = z.infer<typeof actionTypeSchema>;

/** Applied to a `thanks` action with no (or blank) message (B5-D2). */
export const DEFAULT_THANKS_MESSAGE = 'Thanks for your feedback!';
/** The sheet renders `message` as PLAIN TEXT (F1), so a hard length cap is enough. */
export const ACTION_MESSAGE_MAX = 280;
/** URL length cap (B5 edge cases) — generous but bounded. */
export const ACTION_URL_MAX = 2048;

/** A resolved post-submit action stored on a workflow and carried in configs. */
export interface Action {
  type: ActionType;
  message?: string;
  url?: string;
}

/**
 * The wire schema for an action. Accepts the loose `{ type, message?, url? }` an
 * agent might send and NORMALIZES it: a `thanks` gets the default message when
 * blank; a `redirect` is validated (`https://`, well-formed) and its message kept
 * if present; `none`/`store_review` drop stray fields. Idempotent — re-parsing an
 * already-normalized action returns it unchanged.
 */
export const actionSchema = z
  .object({
    type: actionTypeSchema,
    message: z.string().max(ACTION_MESSAGE_MAX).optional(),
    url: z.string().max(ACTION_URL_MAX).optional(),
  })
  .transform((raw, ctx): Action => {
    switch (raw.type) {
      case 'redirect': {
        const url = raw.url?.trim();
        if (!url) {
          ctx.addIssue({
            code: 'custom',
            path: ['url'],
            message: 'a redirect action requires a url',
          });
          return z.NEVER;
        }
        let parsed: URL | undefined;
        try {
          parsed = new URL(url);
        } catch {
          parsed = undefined;
        }
        if (parsed?.protocol !== 'https:') {
          ctx.addIssue({
            code: 'custom',
            path: ['url'],
            message: 'a redirect url must be a valid https:// url',
          });
          return z.NEVER;
        }
        const message = raw.message?.trim();
        return message ? { type: 'redirect', url, message } : { type: 'redirect', url };
      }
      case 'thanks': {
        const message = raw.message?.trim();
        return {
          type: 'thanks',
          message: message && message.length > 0 ? message : DEFAULT_THANKS_MESSAGE,
        };
      }
      default:
        // none | store_review — carry only the type (strip stray message/url).
        return { type: raw.type };
    }
  });
