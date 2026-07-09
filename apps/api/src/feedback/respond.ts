// apps/api/src/feedback/respond.ts
import { type ResponseBody, ratingBoundsFor } from '@signal/contracts';
import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { campaigns, responses, suppressionState, triggerLog } from '../db/schema.js';

export type RespondResult = 'ok' | 'unknown_trigger' | 'invalid_rating';

export async function recordResponse(
  db: Db,
  clock: Clock,
  body: ResponseBody,
): Promise<RespondResult> {
  const [trigger] = await db.select().from(triggerLog).where(eq(triggerLog.id, body.trigger_id));
  if (!trigger) return 'unknown_trigger';

  // Campaign status deliberately NOT checked (M1-D12); we read it only for rating bounds.
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, trigger.campaignId));
  if (!campaign) return 'unknown_trigger';

  const bounds = ratingBoundsFor(campaign.ratingType, campaign.ratingScaleMax);
  if (body.rating_value < bounds.min || body.rating_value > bounds.max) return 'invalid_rating';

  await db.transaction(async (tx) => {
    await tx
      .insert(responses)
      .values({
        triggerId: trigger.id,
        campaignId: trigger.campaignId,
        userId: trigger.userId,
        clientId: trigger.clientId,
        screenId: trigger.screenId,
        ratingValue: body.rating_value,
        chipSelected: body.chip_selected ?? null,
        otherText: body.other_text ?? null,
        otherImageUrl: body.other_image_url ?? null,
        location: body.location ?? null,
        deviceOs: body.device_os,
        appVersion: body.app_version,
        repTenureDays: body.rep_tenure_days ?? null,
        shownAt: new Date(body.shown_at),
        respondedAt: new Date(body.responded_at),
        receivedAt: clock.now(),
      })
      .onConflictDoNothing({ target: responses.triggerId }); // idempotent (M1-D2)

    await tx
      .update(suppressionState)
      .set({ lastAction: 'submitted', nextEligibleAt: null }) // never re-ask (M1-D11)
      .where(
        and(
          eq(suppressionState.userId, trigger.userId),
          eq(suppressionState.campaignId, trigger.campaignId),
        ),
      );
  });
  return 'ok';
}
