import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients } from '../db/schema.js';
import type { SourceClient } from './beatrouteClient.js';

export interface SyncSummary {
  inserted: number;
  updated: number;
  deactivated: number;
}

export async function syncClients(
  db: Db,
  fetchClients: () => Promise<SourceClient[]>,
  now: Date,
): Promise<SyncSummary> {
  const source = await fetchClients(); // throws before any write → cache untouched (M4-D9)
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(clients);
    const existingIds = new Set(existing.map((c) => c.id));
    let inserted = 0;
    let updated = 0;
    let deactivated = 0;

    for (const c of source) {
      if (existingIds.has(c.id)) {
        await tx
          .update(clients)
          .set({ name: c.name, status: c.status, lastSyncedAt: now })
          .where(eq(clients.id, c.id));
        updated++;
      } else {
        await tx
          .insert(clients)
          .values({ id: c.id, name: c.name, status: c.status, lastSyncedAt: now });
        inserted++;
      }
    }

    const sourceIds = new Set(source.map((c) => c.id));
    const toDeactivate = existing.filter((c) => !sourceIds.has(c.id) && c.status !== 'inactive');
    for (const c of toDeactivate) {
      await tx
        .update(clients)
        .set({ status: 'inactive', lastSyncedAt: now })
        .where(eq(clients.id, c.id));
      deactivated++;
    }

    return { inserted, updated, deactivated };
  });
}
