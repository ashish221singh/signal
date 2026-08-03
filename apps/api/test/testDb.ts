import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Insert an account and return its id. Every owned row (workflows, trigger_log,
 * responses, console_users, api_keys) FK-references an account after B1, so the
 * isolation tests and every seed helper start here.
 */
export async function seedAccount(db: Db, name = 'Test Account'): Promise<string> {
  const [row] = await db.insert(schema.accounts).values({ name }).returning();
  if (!row) throw new Error('account seed returned no row');
  return row.id;
}

/** Insert a publishable key for an account (plaintext, unique). Returns the key. */
export async function seedApiKey(
  db: Db,
  accountId: string,
  key: string,
  overrides: Partial<typeof schema.apiKeys.$inferInsert> = {},
): Promise<string> {
  await db.insert(schema.apiKeys).values({
    accountId,
    key,
    label: 'test',
    environment: 'test',
    ...overrides,
  });
  return key;
}

/**
 * Seed an account + one admin console user. Returns both ids. The session guard
 * (B1-D5) loads the user to resolve the account, so console tests must sign a
 * REAL user's id — a bare signed cookie for a non-existent user now 401s.
 */
export async function seedAccountWithUser(
  db: Db,
  opts: { accountName?: string; email?: string } = {},
): Promise<{ accountId: string; userId: string }> {
  const accountId = await seedAccount(db, opts.accountName ?? 'Test Account');
  const [user] = await db
    .insert(schema.consoleUsers)
    .values({
      accountId,
      email: opts.email ?? `admin+${accountId}@example.com`,
      passwordHash: 'x',
      name: 'Admin',
      role: 'admin',
    })
    .returning();
  if (!user) throw new Error('console user seed returned no row');
  return { accountId, userId: user.id };
}

export async function startTestDb(): Promise<{
  db: Db;
  truncateAll: () => Promise<void>;
  stop: () => Promise<void>;
}> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start();
  const { db, close } = createDb(container.getConnectionUri());
  await migrate(db, { migrationsFolder });
  return {
    db,
    truncateAll: async () => {
      await db.execute(sql`
        truncate responses, trigger_log, suppression_state, workflows,
          api_keys, cli_tokens, device_authorizations, seen_events,
          console_users, accounts
        restart identity cascade
      `);
    },
    stop: async () => {
      await close();
      await container.stop();
    },
  };
}
