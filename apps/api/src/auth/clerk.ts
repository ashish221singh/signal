import { createClerkClient, verifyToken } from '@clerk/backend';

/**
 * Clerk backend auth (F3). The dashboard sends a Clerk session JWT as a Bearer
 * token; `verify` checks it against Clerk's JWKS and returns the Clerk user id.
 * `getUser` fetches the email/name (used once, when first creating the Signal
 * account for a Clerk user). Active only when CLERK_SECRET_KEY is configured.
 */
export interface ClerkAuth {
  verify(token: string): Promise<string | null>;
  getUser(userId: string): Promise<{ email: string; name: string } | null>;
}

export function makeClerk(secretKey: string): ClerkAuth {
  const client = createClerkClient({ secretKey });
  return {
    async verify(token: string): Promise<string | null> {
      try {
        const claims = await verifyToken(token, { secretKey });
        return typeof claims.sub === 'string' ? claims.sub : null;
      } catch {
        return null;
      }
    },
    async getUser(userId: string): Promise<{ email: string; name: string } | null> {
      try {
        const u = await client.users.getUser(userId);
        const email =
          u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? null;
        if (!email) return null;
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || email;
        return { email: email.toLowerCase(), name };
      } catch {
        return null;
      }
    },
  };
}
