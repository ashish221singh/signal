// apps/api/src/feedback/dismiss.ts
import type { DismissBody } from '@signal/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { campaigns, suppressionState, triggerLog } from '../db/schema.js';
import { cooldownEndsAt } from '../eligibility/cooldown.js';

export type DismissResult = 'ok' | 'unknown_trigger';

export async function recordDismiss(
  db: Db,
  clock: Clock,
  body: DismissBody,
): Promise<DismissResult> {
  const [trigger] = await db.select().from(triggerLog).where(eq(triggerLog.id, body.trigger_id));
  if (!trigger) return 'unknown_trigger';
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, trigger.campaignId));
  if (!campaign) return 'unknown_trigger';

  const now = clock.now();
  await db
    .update(suppressionState)
    .set({
      lastAction: 'dismissed',
      nextEligibleAt: cooldownEndsAt(campaign.askFrequency, now),
    })
    .where(
      and(
        eq(suppressionState.userId, trigger.userId),
        eq(suppressionState.campaignId, trigger.campaignId),
        isNull(suppressionState.lastAction), // only from provisional state: idempotent + submitted wins
      ),
    );
  return 'ok';
}
