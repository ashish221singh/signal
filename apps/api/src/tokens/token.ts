import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CLI token generation + hashing (B3-D1). Unlike publishable keys, a CLI token IS
 * a secret (it can mutate), so the plaintext `cli_<base62(32)>` is shown once and
 * only its sha256 hash is persisted. sha256 (not argon2) is deliberate: the token
 * is high-entropy random (≈190 bits), so there is nothing to brute-force — a plain
 * one-way hash gives O(1) lookup with no per-verify cost, which the hot-ish Bearer
 * auth path wants.
 */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_LENGTH = 32;

function base62(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += BASE62[byte % 62];
  }
  return out;
}

/** Mint a fresh plaintext CLI token, `cli_<32 base62>`. */
export function generateCliToken(): string {
  return `cli_${base62(SUFFIX_LENGTH)}`;
}

/** sha256-hex of a token — the stored form (unique-indexed for O(1) lookup). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Matches a well-formed CLI token. */
export const CLI_TOKEN_PATTERN = /^cli_[A-Za-z0-9]{32}$/;

/**
 * Constant-time compare of two sha256-hex strings. Guards the (already index-based)
 * verify path against timing side-channels on the hash comparison. Returns false if
 * the lengths differ (a malformed candidate) rather than throwing.
 */
export function constantTimeHashEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
