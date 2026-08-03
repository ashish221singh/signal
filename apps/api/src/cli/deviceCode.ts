import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Device-flow code generation (B3-D3). The `device_code` is a secret the CLI polls
 * with (stored HASHED); the `user_code` is a short, human-typed, unambiguous code
 * shown on the approval page (stored plaintext — it is meant to be read aloud/typed).
 */

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// Crockford-ish, no ambiguous chars (no I,O,0,1) for the human user_code.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function base62(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += BASE62[byte % 62];
  return out;
}

/** A high-entropy device_code, `dev_<40 base62>`. */
export function generateDeviceCode(): string {
  return `dev_${base62(40)}`;
}

/** sha256-hex of the device_code — the stored form. */
export function hashDeviceCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** A short user_code like `ABCD-1234` from an unambiguous alphabet. */
export function generateUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}`;
}
