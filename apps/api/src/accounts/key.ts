import { randomBytes } from 'node:crypto';

/**
 * Publishable key generator (B1-D3). Format `pk_<env>_<base62(24)>`.
 *
 * Publishable keys are NOT secrets — they ship inside client apps — so we use a
 * plain 24-char base62 random suffix (≈143 bits) for uniqueness, not secrecy.
 * `environment` is `live` (prod key from signup) or `test` (dev/seed key).
 */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_LENGTH = 24;

export type KeyEnvironment = 'live' | 'test';

function base62(length: number): string {
  // Rejection-free mapping: draw a byte per char and mod into the 62-char
  // alphabet. The tiny modulo bias is irrelevant for a non-secret uniqueness id.
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE62[bytes[i]! % 62];
  }
  return out;
}

export function generateKey(environment: KeyEnvironment): string {
  return `pk_${environment}_${base62(SUFFIX_LENGTH)}`;
}

/** Matches a well-formed publishable key: `pk_(live|test)_<24 base62>`. */
export const PUBLISHABLE_KEY_PATTERN = /^pk_(live|test)_[A-Za-z0-9]{24}$/;
