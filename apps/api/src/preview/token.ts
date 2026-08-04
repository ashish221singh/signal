import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Hosted-link preview token (F2-D16). A short-lived, stateless, HMAC-signed token
 * that encodes `{ account_id, workflow_id, mode:'preview', exp }`. No DB row and
 * no migration — preview never persists, so the token IS the grant. Signed with
 * the app's `SESSION_SECRET` (the same secret the cookie signer uses), so no new
 * key material is introduced.
 *
 * Format: `base64url(json(payload)).base64url(hmacSha256(payload))`. Verification
 * is constant-time on the signature and checks `exp`. Any tamper/expiry → null,
 * which the route turns into a friendly 404 (never a stack trace).
 */
export interface PreviewClaims {
  account_id: string;
  workflow_id: string;
  mode: 'preview';
  /** Expiry, epoch seconds. */
  exp: number;
}

/** Default lifetime — ~30 minutes (F2-D16). */
export const PREVIEW_TTL_SECONDS = 30 * 60;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** Mint a signed preview token valid for `ttlSeconds` from `nowMs`. */
export function mintPreviewToken(
  claims: Omit<PreviewClaims, 'exp' | 'mode'>,
  secret: string,
  ttlSeconds = PREVIEW_TTL_SECONDS,
  nowMs = Date.now(),
): { token: string; expiresAt: Date } {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload: PreviewClaims = { ...claims, mode: 'preview', exp };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return { token: `${payloadB64}.${sig}`, expiresAt: new Date(exp * 1000) };
}

/** Verify + decode a preview token. Returns the claims or null (tampered/expired). */
export function verifyPreviewToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): PreviewClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payloadB64, secret);
  // Constant-time compare; mismatched lengths (malformed) → reject.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: PreviewClaims | null;
  try {
    claims = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as PreviewClaims | null;
  } catch {
    return null;
  }
  if (
    claims?.mode !== 'preview' ||
    typeof claims.account_id !== 'string' ||
    typeof claims.workflow_id !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    return null;
  }
  if (claims.exp * 1000 <= nowMs) return null; // expired
  return claims;
}
