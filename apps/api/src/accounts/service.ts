import { and, desc, eq, isNull } from 'drizzle-orm';
import { hashPassword } from '../auth/password.js';
import type { Db } from '../db/client.js';
import { accounts, apiKeys, consoleUsers } from '../db/schema.js';
import { generateKey, type KeyEnvironment } from './key.js';

export interface SignupInput {
  email: string;
  password: string;
  name: string;
  accountName: string;
}

export interface SignupResult {
  account: typeof accounts.$inferSelect;
  user: typeof consoleUsers.$inferSelect;
  publishableKey: string;
}

export type IssueKeyResult = typeof apiKeys.$inferSelect;

/**
 * Accounts & keys service (B1-D2, D3, D4). Owns account/user/key lifecycle:
 * transactional signup, key issuance, key→account resolution, and revocation.
 * The publishable-key auth plugin (Task 6) caches `lookupAccountByKey` results.
 */
export class AccountsService {
  constructor(private readonly db: Db) {}

  /**
   * Signup (B1-D2, D10): create the account, its first admin user, and a default
   * publishable key in ONE transaction. Email is globally unique — a duplicate
   * surfaces as the unique-violation this method rethrows, which the route maps
   * to 409. Password is already policy-checked by the request schema (min 8).
   */
  async signup(input: SignupInput, environment: KeyEnvironment = 'live'): Promise<SignupResult> {
    const passwordHash = await hashPassword(input.password);
    const key = generateKey(environment);

    return await this.db.transaction(async (tx) => {
      const [account] = await tx.insert(accounts).values({ name: input.accountName }).returning();
      if (!account) throw new Error('account insert returned no row');

      const [user] = await tx
        .insert(consoleUsers)
        .values({
          accountId: account.id,
          email: input.email,
          passwordHash,
          name: input.name,
          role: 'admin',
        })
        .returning();
      if (!user) throw new Error('console user insert returned no row');

      await tx.insert(apiKeys).values({
        accountId: account.id,
        key,
        label: 'default',
        environment,
      });

      return { account, user, publishableKey: key };
    });
  }

  /**
   * Find-or-create a console user from a verified Google profile (F3). Resolution
   * order:
   *   1. Match by `google_sub` — the stable Google identity → log that user in.
   *   2. Else match by `email` — an existing (e.g. password) account with the same
   *      verified email → LINK it by stamping `google_sub`, then log in. Google
   *      emails are verified, so linking by email is safe and avoids duplicate
   *      accounts for the same person.
   *   3. Else create a fresh account + admin user (no password) + default
   *      publishable key, mirroring password signup.
   * Returns the user, its account id, and whether the account was newly created.
   */
  async findOrCreateGoogleUser(
    input: { googleSub: string; email: string; name: string },
    environment: KeyEnvironment = 'live',
  ): Promise<{ user: typeof consoleUsers.$inferSelect; accountId: string; created: boolean }> {
    const [bySub] = await this.db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.googleSub, input.googleSub))
      .limit(1);
    if (bySub) return { user: bySub, accountId: bySub.accountId, created: false };

    const [byEmail] = await this.db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.email, input.email))
      .limit(1);
    if (byEmail) {
      const [linked] = await this.db
        .update(consoleUsers)
        .set({ googleSub: input.googleSub })
        .where(eq(consoleUsers.id, byEmail.id))
        .returning();
      const user = linked ?? byEmail;
      return { user, accountId: user.accountId, created: false };
    }

    const key = generateKey(environment);
    return await this.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(accounts)
        .values({ name: input.name || input.email })
        .returning();
      if (!account) throw new Error('account insert returned no row');

      const [user] = await tx
        .insert(consoleUsers)
        .values({
          accountId: account.id,
          email: input.email,
          passwordHash: null,
          googleSub: input.googleSub,
          name: input.name || input.email,
          role: 'admin',
        })
        .returning();
      if (!user) throw new Error('console user insert returned no row');

      await tx.insert(apiKeys).values({
        accountId: account.id,
        key,
        label: 'default',
        environment,
      });

      return { user, accountId: account.id, created: true };
    });
  }

  /** Create a bare account (bootstrap/seed use). */
  async createAccount(name: string): Promise<typeof accounts.$inferSelect> {
    const [account] = await this.db.insert(accounts).values({ name }).returning();
    if (!account) throw new Error('account insert returned no row');
    return account;
  }

  /** Create an admin console user under an account (bootstrap/seed use). */
  async createConsoleUser(input: {
    accountId: string;
    email: string;
    password: string;
    name: string;
    role?: 'admin' | 'editor';
  }): Promise<typeof consoleUsers.$inferSelect> {
    const passwordHash = await hashPassword(input.password);
    const [user] = await this.db
      .insert(consoleUsers)
      .values({
        accountId: input.accountId,
        email: input.email,
        passwordHash,
        name: input.name,
        role: input.role ?? 'admin',
      })
      .returning();
    if (!user) throw new Error('console user insert returned no row');
    return user;
  }

  /** Issue a new publishable key for an account. */
  async issueKey(
    accountId: string,
    environment: KeyEnvironment,
    label = 'default',
  ): Promise<IssueKeyResult> {
    const key = generateKey(environment);
    const [row] = await this.db
      .insert(apiKeys)
      .values({ accountId, key, label, environment })
      .returning();
    if (!row) throw new Error('api key insert returned no row');
    return row;
  }

  /**
   * Create a publishable key with an optional origin allow-list (B3 key management,
   * B2-D7). Returns the full row (incl. the plaintext key — publishable keys are
   * NOT secrets and are safe to return on list).
   */
  async createKey(
    accountId: string,
    input: { label: string; environment: KeyEnvironment; allowedOrigins: string[] },
  ): Promise<IssueKeyResult> {
    const key = generateKey(input.environment);
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        accountId,
        key,
        label: input.label,
        environment: input.environment,
        allowedOrigins: input.allowedOrigins,
      })
      .returning();
    if (!row) throw new Error('api key insert returned no row');
    return row;
  }

  /** List an account's publishable keys, newest first (B3 key management). */
  async listKeys(accountId: string): Promise<IssueKeyResult[]> {
    return this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, accountId))
      .orderBy(desc(apiKeys.createdAt));
  }

  /**
   * Revoke a key by id, scoped to `accountId` (isolation). Idempotent. Returns
   * whether a matching row was found.
   */
  async revokeKeyById(accountId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.accountId, accountId)))
      .returning({ id: apiKeys.id });
    return Boolean(row);
  }

  /**
   * Resolve a publishable key → account_id (B1-D4). Returns the account_id for a
   * live (non-revoked) key, or null for an unknown/revoked key. The auth plugin
   * layers a 60s in-memory cache over this so the hot path stays off the DB.
   */
  async lookupAccountByKey(key: string): Promise<string | null> {
    const resolved = await this.resolveKey(key);
    return resolved?.accountId ?? null;
  }

  /**
   * Resolve a publishable key → `{ accountId, allowedOrigins }` (B2-D7). Returns
   * null for an unknown/revoked key. `allowedOrigins` is the per-account browser
   * origin allow-list — enforced by the SDK auth plugin only when an `Origin`
   * header is present (native SDKs send none and pass).
   */
  async resolveKey(key: string): Promise<{ accountId: string; allowedOrigins: string[] } | null> {
    const [row] = await this.db
      .select({ accountId: apiKeys.accountId, allowedOrigins: apiKeys.allowedOrigins })
      .from(apiKeys)
      .where(and(eq(apiKeys.key, key), isNull(apiKeys.revokedAt)))
      .limit(1);
    return row ? { accountId: row.accountId, allowedOrigins: row.allowedOrigins } : null;
  }

  /** Revoke a key by stamping `revoked_at`. Idempotent (only revokes live keys). */
  async revokeKey(key: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.key, key), isNull(apiKeys.revokedAt)));
  }
}
