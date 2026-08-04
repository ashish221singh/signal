// apps/api/src/feedback/dismiss.ts
import type { DismissBody } from '@signal/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { suppressionState, triggerLog, workflows } from '../db/schema.js';
import { cooldownEndsAt } from '../eligibility/cooldown.js';

export type DismissResult = 'ok' | 'unknown_trigger';

export async function recordDismiss(
  db: Db,
  clock: Clock,
  body: DismissBody,
): Promise<DismissResult> {
  const [trigger] = await db.select().from(triggerLog).where(eq(triggerLog.id, body.trigger_id));
  if (!trigger) return 'unknown_trigger';
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, trigger.workflowId));
  if (!workflow) return 'unknown_trigger';

  const now = clock.now();
  await db
    .update(suppressionState)
    .set({
      lastAction: 'dismissed',
      nextEligibleAt: cooldownEndsAt(workflow.askFrequency, now),
    })
    .where(
      and(
        eq(suppressionState.userId, trigger.userId),
        eq(suppressionState.workflowId, trigger.workflowId),
        isNull(suppressionState.lastAction), // only from provisional state: idempotent + submitted wins
      ),
    );
  return 'ok';
}
