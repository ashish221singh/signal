// apps/api/src/scripts/sync-clients.ts
// Operational CLI: fetch a fresh OAuth token per run (M4-D7, no cache), pull the
// client list from BeatRoute, run the upsert, and print a summary. On any
// token/list failure we log WHICH step failed, leave `clients` untouched, and
// exit non-zero so the scheduler/alerting notices (M4-D9).
// Run with: pnpm --filter @signal/api sync-clients
import { createDb } from '../db/client.js';
import { parseEnv } from '../env.js';
import { BeatRouteClient, BeatRouteError, withRetry } from '../sync/beatrouteClient.js';
import { syncClients } from '../sync/syncClients.js';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const client = new BeatRouteClient({
    tokenUrl: env.BEATROUTE_TOKEN_URL,
    clientsUrl: env.BEATROUTE_CLIENTS_API_URL,
    clientId: env.BEATROUTE_CLIENT_ID,
    clientSecret: env.BEATROUTE_CLIENT_SECRET,
    scope: env.BEATROUTE_OAUTH_SCOPE,
  });
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    const summary = await syncClients(
      db,
      async () => {
        const token = await withRetry(() => client.fetchToken());
        return withRetry(() => client.fetchClients(token));
      },
      new Date(),
    );
    console.log(
      `client sync ok — inserted ${summary.inserted}, updated ${summary.updated}, deactivated ${summary.deactivated}`,
    );
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const step = error instanceof BeatRouteError ? ` (step: ${error.step})` : '';
    console.error(`client sync FAILED${step} — cache left untouched:`, error);
    process.exit(1); // M4-D9: non-zero so the scheduler/alerting notices
  },
);
