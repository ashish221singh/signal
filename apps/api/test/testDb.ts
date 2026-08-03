import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Insert an account and return its id. Every owned row (targets, campaigns,
 * trigger_log, responses, console_users, api_keys) FK-references an account
 * after B1, so the isolation tests and every seed helper start here.
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
        truncate responses, trigger_log, suppression_state, campaigns, target_registry,
          api_keys, console_users, accounts
        restart identity cascade
      `);
    },
    stop: async () => {
      await close();
      await container.stop();
    },
  };
}
