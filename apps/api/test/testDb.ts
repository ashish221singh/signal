import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Db } from '../src/db/client.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

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
        truncate responses, trigger_log, suppression_state, campaigns, target_registry, clients
        restart identity cascade
      `);
    },
    stop: async () => {
      await close();
      await container.stop();
    },
  };
}
