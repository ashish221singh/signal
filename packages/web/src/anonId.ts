/**
 * Anonymous id (F2-D9, F2-D17). When the host supplies no `userId`, the SDK
 * generates a UUIDv4 once and persists it in `localStorage['signal_anon_id']`,
 * reusing it across page loads so suppression/cooldown have a stable subject. A
 * host-supplied `userId` always supersedes it. If localStorage is unavailable
 * (private mode / disabled) we fall back to a per-session in-memory id so the SDK
 * still functions (degraded: no cross-load stability).
 */
import { debug } from './log.js';

const ANON_KEY = 'signal_anon_id';

let memoryId: string | null = null;

/** RFC4122 v4 uuid, preferring the platform crypto and falling back to Math.random. */
function uuidv4(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback: not cryptographically strong, but fine for an anonymous id.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function safeLocalStorage(): Storage | null {
  try {
    const ls = globalThis.localStorage;
    // Touch it — some browsers throw only on access in private mode.
    const probe = '__signal_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** Return the persisted anonymous id, generating + storing one on first use. */
export function getAnonId(): string {
  const ls = safeLocalStorage();
  if (!ls) {
    if (!memoryId) {
      memoryId = uuidv4();
      debug('localStorage unavailable — using an in-memory anonymous id');
    }
    return memoryId;
  }
  const existing = ls.getItem(ANON_KEY);
  if (existing) return existing;
  const fresh = uuidv4();
  try {
    ls.setItem(ANON_KEY, fresh);
  } catch {
    // Quota/write error — keep it in memory for the session at least.
    memoryId = fresh;
  }
  return fresh;
}
