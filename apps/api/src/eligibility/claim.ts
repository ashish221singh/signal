import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/**
 * Atomic check-and-claim (M1-D9/D10). Returns true if this call won the right
 * to show. Loses when a row exists with next_eligible_at NULL (never re-ask)
 * or in the future (suppressed) — including a row written microseconds ago
 * by a concurrent request.
 */
export async function claimShow(
  db: Db,
  userId: string,
  workflowId: string,
  now: Date,
  nextEligibleAt: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const nextIso = nextEligibleAt.toISOString();
  const result = await db.execute(sql`
    insert into suppression_state (user_id, workflow_id, last_shown_at, last_action, next_eligible_at)
    values (${userId}, ${workflowId}, ${nowIso}::timestamptz, null, ${nextIso}::timestamptz)
    on conflict (user_id, workflow_id) do update
      set last_shown_at = ${nowIso}::timestamptz, last_action = null, next_eligible_at = ${nextIso}::timestamptz
      where suppression_state.next_eligible_at is not null
        and suppression_state.next_eligible_at <= ${nowIso}::timestamptz
    returning user_id
  `);
  return result.length === 1;
}
