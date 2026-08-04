/**
 * Eligibility call (fail-silent, F2-D10). GET `/v1/sdk/eligibility` with the
 * `X-Signal-App-Key` header and a ~2s timeout. ANY error/timeout/401/429/malformed
 * → returns null (no sheet, no throw). A 204 means "not eligible" → null. A 200
 * returns the `EligibilityConfig` (parsed leniently — we only read the fields
 * web-core needs; the backend already validated it).
 */
import type { EligibilityConfig } from '@signal/contracts';
import { debug } from './log.js';

const DEFAULT_TIMEOUT_MS = 2000;

export interface EligibilityInput {
  apiUrl: string;
  publishableKey: string;
  eventName: string;
  userId: string;
  context?: string;
  sessionAgeDays?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function checkEligibility(input: EligibilityInput): Promise<EligibilityConfig | null> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    debug('eligibility: no fetch available');
    return null;
  }

  const params = new URLSearchParams({
    event_name: input.eventName,
    user_id: input.userId,
  });
  if (input.context) params.set('context', input.context);
  if (typeof input.sessionAgeDays === 'number') {
    params.set('session_age_days', String(input.sessionAgeDays));
  }
  const url = `${input.apiUrl.replace(/\/$/, '')}/v1/sdk/eligibility?${params.toString()}`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timeout = controller
    ? setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    : undefined;

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-Signal-App-Key': input.publishableKey },
      signal: controller?.signal,
    });
    if (res.status === 204) return null; // not eligible
    if (res.status !== 200) {
      debug('eligibility: non-200, failing silent', res.status);
      return null;
    }
    const config = (await res.json()) as EligibilityConfig;
    if (!config || typeof config !== 'object' || typeof config.trigger_id !== 'string') {
      debug('eligibility: malformed config, failing silent');
      return null;
    }
    return config;
  } catch (err) {
    // Timeout / offline / DNS / malformed JSON → fail silent (F2-D10).
    debug('eligibility: request failed, failing silent', err);
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
