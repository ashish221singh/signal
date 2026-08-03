// apps/api/src/feedback/respond.ts
import { type ResponseBody, ratingBoundsFor } from '@signal/contracts';
import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { responses, suppressionState, triggerLog, workflows } from '../db/schema.js';
import type { Env } from '../env.js';
import { isUrlUnderAccountPrefix } from '../uploads/presign.js';

export type RespondResult = 'ok' | 'unknown_trigger' | 'invalid_rating' | 'invalid_image_url';

export async function recordResponse(
  db: Db,
  clock: Clock,
  env: Env,
  accountId: string,
  body: ResponseBody,
): Promise<RespondResult> {
  const [trigger] = await db.select().from(triggerLog).where(eq(triggerLog.id, body.trigger_id));
  if (!trigger) return 'unknown_trigger';

  // Workflow status deliberately NOT checked (M1-D12); we read it only for rating bounds.
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, trigger.workflowId));
  if (!workflow) return 'unknown_trigger';
  // ratingType is nullable on drafts; a workflow with a live trigger is always
  // complete (active), but guard defensively so a rating can't be validated
  // against a null bound.
  if (workflow.ratingType === null) return 'invalid_rating';

  const bounds = ratingBoundsFor(workflow.ratingType, workflow.ratingScaleMax);
  if (body.rating_value < bounds.min || body.rating_value > bounds.max) return 'invalid_rating';

  // B4-D1: a supplied image URL must sit under THIS caller's account prefix
  // (`${S3_PUBLIC_URL}/acct/<accountId>/…`). A forged URL pointing at another
  // account's prefix (or an arbitrary host) is rejected before storage.
  if (
    body.other_image_url != null &&
    !isUrlUnderAccountPrefix(env, accountId, body.other_image_url)
  )
    return 'invalid_image_url';

  await db.transaction(async (tx) => {
    await tx
      .insert(responses)
      .values({
        accountId: trigger.accountId,
        triggerId: trigger.id,
        workflowId: trigger.workflowId,
        userId: trigger.userId,
        eventName: trigger.eventName,
        context: trigger.context,
        ratingValue: body.rating_value,
        chipSelected: body.chip_selected ?? null,
        otherText: body.other_text ?? null,
        otherImageUrl: body.other_image_url ?? null,
        location: body.location ?? null,
        deviceOs: body.device_os,
        appVersion: body.app_version,
        sessionAgeDays: body.session_age_days ?? null,
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
          eq(suppressionState.workflowId, trigger.workflowId),
        ),
      );
  });
  return 'ok';
}
