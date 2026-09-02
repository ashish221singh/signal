import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing for console users (M2-D3): argon2 via `@node-rs/argon2`
 * prebuilt binaries, using the library's default parameters.
 *
 * `verifyPassword` deliberately returns `false` (never throws) when the stored
 * hash is malformed or garbage: `verify` throws on an unparseable hash, so the
 * catch converts that into a plain non-match. This keeps a corrupt stored hash
 * from crashing the login flow and prevents it from leaking via a distinct
 * error path — the empty catch is intentional, not an oversight.
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(storedHash: string | null, plain: string): Promise<boolean> {
  // A Google-OAuth user (F3) has no password hash — never a password match.
  if (!storedHash) return false;
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
