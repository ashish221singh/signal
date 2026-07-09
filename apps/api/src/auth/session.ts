import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Console session (M2-D2): stateless, signed, httpOnly cookie — there is no
 * session table. The signed value is the console user's id; `@fastify/cookie`
 * (registered with `env.SESSION_SECRET`) signs on write and verifies on read.
 * `sameSite=strict` and `secure` in production only; 12h expiry.
 */
const COOKIE = 'signal_session';
const MAX_AGE_S = 12 * 60 * 60;

// Shared attributes so the clearing cookie mirrors the one we set — a delete
// cookie must carry the same path/sameSite/secure to reliably overwrite it.
const cookieAttrs = () => ({
  path: '/',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
});

export function issueSession(reply: FastifyReply, userId: string): void {
  reply.setCookie(COOKIE, userId, { ...cookieAttrs(), signed: true, maxAge: MAX_AGE_S });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, cookieAttrs());
}

export function readSession(request: FastifyRequest): string | null {
  const raw = request.cookies[COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}
