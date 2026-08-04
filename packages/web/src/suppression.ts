/**
 * Local suppression short-circuit (F2-D11). Before an eligibility call the SDK
 * checks a small localStorage cache keyed by (userId, eventName); if the local
 * cooldown has not elapsed it skips the network entirely. The server stays
 * authoritative on a cache miss — this is a hot-path optimisation, never the sole
 * source of truth. We set a client-side cooldown after a dismiss/submit so a
 * second `track` in the same session doesn't re-hit eligibility needlessly.
 */
import { debug } from './log.js';

const KEY = 'signal_suppress';

// A conservative client-side cooldown. The server's own cooldown (keyed on
// trigger_id) remains authoritative; this only blunts obvious repeats.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type SuppressMap = Record<string, number>; // cacheKey -> nextEligibleAt (epoch ms)

function cacheKey(userId: string, eventName: string): string {
  return `${userId}::${eventName}`;
}

function read(): SuppressMap {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SuppressMap) : {};
  } catch {
    return {};
  }
}

function write(map: SuppressMap): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(map));
  } catch {
    // Best-effort; a failed write just means no local short-circuit.
    debug('suppression cache write failed (ignored)');
  }
}

/** True when the local cache says this (user, event) is still cooling down. */
export function isSuppressed(userId: string, eventName: string, now = Date.now()): boolean {
  const map = read();
  const until = map[cacheKey(userId, eventName)];
  return typeof until === 'number' && until > now;
}

/** Record a local cooldown after a shown sheet resolves (dismiss/submit). */
export function markSuppressed(
  userId: string,
  eventName: string,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now(),
): void {
  const map = read();
  map[cacheKey(userId, eventName)] = now + cooldownMs;
  write(map);
}
