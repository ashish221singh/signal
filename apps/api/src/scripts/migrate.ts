import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Production migration runner (F3 deploy). Run at container startup before the API.
 * Unlike `drizzle-kit migrate`, this sets a connect timeout and retries — Railway's
 * private network (`*.railway.internal`) can take a few seconds to become reachable
 * after a container starts, and a plain migrate would hang forever instead.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: DATABASE_URL is not set');
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const MAX_ATTEMPTS = 20;

async function run(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const sql = postgres(url as string, { max: 1, connect_timeout: 10 });
    try {
      await migrate(drizzle(sql), { migrationsFolder });
      await sql.end({ timeout: 5 });
      console.log('migrate: migrations applied');
      return;
    } catch (err) {
      await sql.end({ timeout: 5 }).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`migrate: attempt ${attempt}/${MAX_ATTEMPTS} failed — ${msg}`);
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

run().catch((err) => {
  console.error('migrate: giving up', err);
  process.exit(1);
});
