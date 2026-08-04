import { ALL_CLI_SCOPES, type CliScope, type CliToken } from '@signal/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { cliTokens } from '../db/schema.js';
import { constantTimeHashEqual, generateCliToken, hashToken } from './token.js';

/** Default CLI-token lifetime (B3-D1): 90 days. */
export const CLI_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface IssueTokenResult {
  /** The plaintext token — shown once, never persisted. */
  token: string;
  meta: CliToken;
}

/** Resolved token identity used by the unified auth path (B3-D5). */
export interface ResolvedToken {
  accountId: string;
  scopes: CliScope[];
}

type CliTokenRow = typeof cliTokens.$inferSelect;

function toCliToken(r: CliTokenRow): CliToken {
  return {
    id: r.id,
    name: r.name,
    scopes: r.scopes as CliScope[],
    created_at: r.createdAt,
    last_used_at: r.lastUsedAt,
    expires_at: r.expiresAt,
    revoked_at: r.revokedAt,
  };
}

/**
 * CLI-token service (B3-D1, D2). Owns issue / verify / revoke / list. Tokens are
 * stored sha256-hashed; the plaintext is returned only at issue. `verify` is the
 * hot-ish Bearer path — an index lookup on the hash, a constant-time compare, then
 * expiry/revocation gates — and it stamps `last_used_at` on success.
 */
export class TokenService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  /**
   * Issue a token for an account. `scopes` defaults to all four (B3-D2 — device
   * flow / interim login mint the full set); `ttlMs` defaults to 90d.
   */
  async issue(
    accountId: string,
    name: string,
    opts: { scopes?: CliScope[]; ttlMs?: number } = {},
  ): Promise<IssueTokenResult> {
    const token = generateCliToken();
    const tokenHash = hashToken(token);
    const scopes = opts.scopes ?? [...ALL_CLI_SCOPES];
    const expiresAt = new Date(this.clock.now().getTime() + (opts.ttlMs ?? CLI_TOKEN_TTL_MS));
    const [row] = await this.db
      .insert(cliTokens)
      .values({ accountId, tokenHash, name, scopes, expiresAt })
      .returning();
    if (!row) throw new Error('cli token insert returned no row');
    return { token, meta: toCliToken(row) };
  }

  /**
   * Verify a presented plaintext token → `{ accountId, scopes }` or null. Rejects
   * an unknown, expired, or revoked token. On success stamps `last_used_at`. The
   * lookup is by unique hash index; a constant-time compare defends the (already
   * narrow) hash match against timing analysis.
   */
  async verify(token: string): Promise<ResolvedToken | null> {
    const tokenHash = hashToken(token);
    const [row] = await this.db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    if (!constantTimeHashEqual(row.tokenHash, tokenHash)) return null;

    const now = this.clock.now();
    if (row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;

    // Best-effort: stamp usage. A failure here must not fail auth.
    await this.db
      .update(cliTokens)
      .set({ lastUsedAt: now })
      .where(eq(cliTokens.id, row.id))
      .catch(() => {});

    return { accountId: row.accountId, scopes: row.scopes as CliScope[] };
  }

  /** List an account's tokens (metadata only — never the plaintext), newest first. */
  async list(accountId: string): Promise<CliToken[]> {
    const rows = await this.db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.accountId, accountId))
      .orderBy(desc(cliTokens.createdAt));
    return rows.map(toCliToken);
  }

  /**
   * Revoke a token by id, scoped to `accountId` (isolation — an account can only
   * revoke its own). Idempotent: revoking again is a no-op. Returns whether a
   * matching (still-live) token was found.
   */
  async revoke(accountId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .update(cliTokens)
      .set({ revokedAt: this.clock.now() })
      .where(and(eq(cliTokens.id, id), eq(cliTokens.accountId, accountId)))
      .returning({ id: cliTokens.id });
    return Boolean(row);
  }
}
