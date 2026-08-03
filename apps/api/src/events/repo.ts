import type { SeenEvent } from '@signal/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { seenEvents } from '../db/schema.js';

/**
 * Best-effort upsert of a first-sighting into `seen_events` (B3-D7). On conflict
 * (the PK `(account_id, event_name)`) it bumps `last_seen_at` + `hit_count` — this
 * only runs once per new event per process, so it is off the steady-state hot path.
 */
export async function upsertSeenEvent(
  db: Db,
  accountId: string,
  eventName: string,
  now: Date,
): Promise<void> {
  await db
    .insert(seenEvents)
    .values({ accountId, eventName, firstSeenAt: now, lastSeenAt: now, hitCount: 1 })
    .onConflictDoUpdate({
      target: [seenEvents.accountId, seenEvents.eventName],
      set: {
        lastSeenAt: now,
        hitCount: sql`${seenEvents.hitCount} + 1`,
      },
    });
}

/** List an account's surfaced events, most-recently-seen first (B3-D7). */
export async function listSeenEvents(db: Db, accountId: string): Promise<SeenEvent[]> {
  const rows = await db
    .select()
    .from(seenEvents)
    .where(eq(seenEvents.accountId, accountId))
    .orderBy(desc(seenEvents.lastSeenAt));
  return rows.map((r) => ({
    event_name: r.eventName,
    first_seen_at: r.firstSeenAt,
    last_seen_at: r.lastSeenAt,
    hit_count: r.hitCount,
  }));
}
