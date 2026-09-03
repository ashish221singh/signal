/**
 * `@signal/web` — the flagship Web SDK (F2 Task 1+2). Wraps the pure
 * `@signal/web-core` sheet with real transport against `/v1/sdk/*` using a
 * publishable key.
 *
 * Public API (F2-D2):
 *   Signal.init(publishableKey, { apiUrl?, userId? })
 *   Signal.track(eventName, { userId?, context?, sessionAgeDays? })
 *
 * Contracts (edge cases from the plan):
 *   - track-before-init  → no-op + ONE dev warning.
 *   - double init        → idempotent single instance; second init updates config.
 *   - eligibility        → fail-silent (F2-D10); local suppression short-circuit
 *                          (F2-D11) skips the network entirely.
 *   - responses          → precious durable outbox (F2-D18), idempotent on
 *                          trigger_id, retries with backoff, storage fallback (F2-D12).
 */
import { mount } from '@signal/web-core';
import { getAnonId } from './anonId.js';
import { checkEligibility } from './eligibility.js';
import { debug, warnOnce } from './log.js';
import { Outbox } from './outbox.js';
import { isSuppressed } from './suppression.js';
import { createWebHost } from './webHost.js';

/**
 * Human-readable identity for the current end-user (F5). These are YOUR OWN user's
 * traits, shown next to their feedback in your dashboard. The stable key is the
 * `userId` (also your own id); name/email are optional display fields.
 */
export interface UserTraits {
  /** The user's display name, e.g. "John Doe". */
  name?: string;
  /** The user's email, e.g. "john@acme.com". */
  email?: string;
}

export interface InitOptions {
  /** The Signal API base URL. Defaults to the same origin the page is served from. */
  apiUrl?: string;
  /** A stable host user id — YOUR id, from YOUR system. Omit ⇒ anonymous id (F2-D9). */
  userId?: string;
  /** Optional name/email for the user id above (shown in your dashboard, F5). */
  traits?: UserTraits;
  /** Injectable for tests (fetch + clock). */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TrackOptions {
  /** Overrides the init-time userId for this event only. */
  userId?: string;
  /** Overrides the init/identify traits for this event only (F5). */
  traits?: UserTraits;
  /** Free-text metadata (never a targeting key), e.g. a screen name for debugging. */
  context?: string;
  /** Feeds the optional min-session-age gate. */
  sessionAgeDays?: number;
}

interface Instance {
  publishableKey: string;
  apiUrl: string;
  userId?: string;
  /** Current end-user traits (name/email) from init/identify (F5). */
  traits?: UserTraits;
  fetchImpl?: typeof fetch;
  now: () => number;
  outbox: Outbox;
  /** Coalesce duplicate tracks while an eligibility check or sheet is in flight
   *  (F1-D13): one sheet, no double eligibility for the same open trigger. */
  busy: boolean;
}

let instance: Instance | null = null;

function defaultApiUrl(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin ?? '';
}

/**
 * Resolve the mount root. web-core attaches its own Shadow DOM host, so we just
 * need an element in the live document to append into.
 */
function mountRoot(): HTMLElement | null {
  const doc = (globalThis as { document?: Document }).document;
  return doc?.body ?? null;
}

export const Signal = {
  /**
   * Initialise the SDK. Idempotent: a second call updates the config on the
   * existing singleton rather than creating a duplicate (edge case: script loaded
   * twice / init called twice).
   */
  init(publishableKey: string, options: InitOptions = {}): void {
    const apiUrl = options.apiUrl ?? defaultApiUrl();
    const now = options.now ?? (() => Date.now());
    if (instance) {
      // Idempotent update — keep the single outbox, refresh the mutable config.
      instance.publishableKey = publishableKey;
      instance.apiUrl = apiUrl;
      instance.userId = options.userId ?? instance.userId;
      instance.traits = options.traits ?? instance.traits;
      instance.fetchImpl = options.fetchImpl ?? instance.fetchImpl;
      debug('init called again — updated existing instance (idempotent)');
      return;
    }
    const outbox = new Outbox({
      apiUrl,
      publishableKey,
      now,
      fetchImpl: options.fetchImpl,
    });
    instance = {
      publishableKey,
      apiUrl,
      userId: options.userId,
      traits: options.traits,
      fetchImpl: options.fetchImpl,
      now,
      outbox,
      busy: false,
    };
    // Flush anything left over from a previous load (killed-before-flush, F2-D18).
    void outbox.flush();
  },

  /**
   * Associate the current end-user with YOUR own id and optional name/email (F5).
   * Call once after login (or on boot for a returning user); every subsequent
   * track/response is attributed to this identity. A no-op + one dev warning if
   * called before init. Passing new traits merges over any existing ones.
   */
  identify(userId: string, traits: UserTraits = {}): void {
    const inst = instance;
    if (!inst) {
      warnOnce('Signal.identify() called before Signal.init() — ignoring.');
      return;
    }
    inst.userId = userId;
    inst.traits = { ...inst.traits, ...traits };
  },

  /**
   * Record an event and, if eligible, show the feedback sheet. Never throws into
   * the host (F2-D10). Track-before-init is a no-op + one dev warning.
   */
  async track(eventName: string, options: TrackOptions = {}): Promise<void> {
    const inst = instance;
    if (!inst) {
      warnOnce(
        'Signal.track() called before Signal.init() — ignoring. Call Signal.init(key) first.',
      );
      return;
    }
    // Coalesce concurrent/duplicate tracks (F1-D13).
    if (inst.busy) {
      debug('track ignored — a sheet or eligibility check is already in flight');
      return;
    }

    const userId = options.userId ?? inst.userId ?? getAnonId();
    // Resolve the display traits for this event (per-track override ▸ instance).
    const traits = options.traits ?? inst.traits;

    // Local suppression short-circuit (F2-D11): skip the network entirely.
    if (isSuppressed(userId, eventName)) {
      debug('track suppressed locally — skipping eligibility', eventName);
      return;
    }

    inst.busy = true;
    try {
      const config = await checkEligibility({
        apiUrl: inst.apiUrl,
        publishableKey: inst.publishableKey,
        eventName,
        userId,
        context: options.context,
        sessionAgeDays: options.sessionAgeDays,
        fetchImpl: inst.fetchImpl,
      });
      if (!config) return; // not eligible / failed silent — show nothing.

      const root = mountRoot();
      if (!root) {
        debug('no document to mount into — skipping sheet');
        return;
      }

      const shownAt = new Date(inst.now()).toISOString();
      const host = createWebHost({
        apiUrl: inst.apiUrl,
        publishableKey: inst.publishableKey,
        outbox: inst.outbox,
        userId,
        userName: traits?.name,
        userEmail: traits?.email,
        eventName,
        triggerId: config.trigger_id,
        shownAt,
        sessionAgeDays: options.sessionAgeDays,
        now: inst.now,
        fetchImpl: inst.fetchImpl,
      });

      mount(root, config, host);
    } catch (err) {
      // Belt-and-braces: track must never throw into the host (F2-D10).
      debug('track failed silently', err);
    } finally {
      inst.busy = false;
    }
  },
};

/** Test-only: reset the module singleton between cases. */
export function __resetForTests(): void {
  instance = null;
}

export type { EligibilityConfig } from '@signal/contracts';
