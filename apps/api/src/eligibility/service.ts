import type { EligibilityConfig } from '@signal/contracts';
import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { suppressionState, triggerLog } from '../db/schema.js';
import type { WorkflowCache } from '../workflows/cache.js';
import { claimShow } from './claim.js';
import { cooldownEndsAt } from './cooldown.js';
import { decide } from './decide.js';

export interface EligibilityQueryInput {
  accountId: string;
  eventName: string;
  userId: string;
  context?: string;
  sessionAgeDays?: number;
}

export class EligibilityService {
  constructor(
    private readonly db: Db,
    private readonly cache: WorkflowCache,
    private readonly clock: Clock,
    // Injected RNG (B2-D4) so tests can force sampled/not-sampled deterministically.
    private readonly rng: () => number = Math.random,
  ) {}

  async check(input: EligibilityQueryInput): Promise<EligibilityConfig | null> {
    const workflow = this.cache.match(input.accountId, input.eventName);
    if (!workflow) return null;

    const now = this.clock.now();

    const [suppression] = await this.db
      .select()
      .from(suppressionState)
      .where(
        and(
          eq(suppressionState.userId, input.userId),
          eq(suppressionState.workflowId, workflow.id),
        ),
      );

    const decision = decide({
      workflow: {
        minSessionAgeDays: workflow.minSessionAgeDays,
        samplingRate: workflow.samplingRate,
      },
      suppression: suppression
        ? { nextEligibleAt: suppression.nextEligibleAt, lastAction: suppression.lastAction }
        : undefined,
      sessionAgeDays: input.sessionAgeDays,
      now,
      rng: this.rng,
    });
    // Not eligible (suppressed / under session age / not_sampled) → write nothing
    // (B2-D4: a skipped ask must not consume the user's cooldown).
    if (!decision.eligible) return null;

    const nextEligibleAt = cooldownEndsAt(workflow.askFrequency, now);

    return await this.db.transaction(async (tx) => {
      const claimed = await claimShow(
        tx as unknown as Db,
        input.userId,
        workflow.id,
        now,
        nextEligibleAt,
      );
      if (!claimed) return null; // lost the race — someone else is showing right now
      const [trigger] = await tx
        .insert(triggerLog)
        .values({
          accountId: input.accountId,
          workflowId: workflow.id,
          userId: input.userId,
          eventName: input.eventName,
          context: input.context ?? null,
          shownAt: now,
        })
        .returning();
      if (!trigger) throw new Error('trigger insert returned no row');
      return {
        trigger_id: trigger.id,
        campaign_id: workflow.id,
        metric_type: workflow.metricType,
        header: workflow.headerText,
        rating_type: workflow.ratingType,
        rating_scale_max: workflow.ratingScaleMax,
        positive_threshold: workflow.positiveThreshold,
        chips_on_negative: workflow.chipsOnNegative,
        other_requires_text: workflow.otherRequiresText,
        other_allows_image: workflow.otherAllowsImage,
        on_positive_action: workflow.onPositiveAction,
        skip_enabled: true,
      };
    });
  }
}
