import type { EligibilityConfig } from '@signal/contracts';
import { and, eq } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { suppressionState, triggerLog } from '../db/schema.js';
import { upsertSeenEvent } from '../events/repo.js';
import { SeenEventSet } from '../events/seenSet.js';
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
  private readonly seen: SeenEventSet;

  constructor(
    private readonly db: Db,
    private readonly cache: WorkflowCache,
    private readonly clock: Clock,
    // Injected RNG (B2-D4) so tests can force sampled/not-sampled deterministically.
    private readonly rng: () => number = Math.random,
    // Event surfacing (B3-D7): the in-memory first-sighting set. Injectable so a
    // test can share/inspect it. `onUpsert` is the best-effort async writer.
    seen: SeenEventSet = new SeenEventSet(),
    private readonly onUpsert: (
      accountId: string,
      eventName: string,
      now: Date,
    ) => Promise<void> = (accountId, eventName, now) =>
      upsertSeenEvent(this.db, accountId, eventName, now),
  ) {
    this.seen = seen;
  }

  async check(input: EligibilityQueryInput): Promise<EligibilityConfig | null> {
    const now = this.clock.now();

    // Event surfacing (B3-D7): record the sighting BEFORE the match short-circuit so
    // events that have no workflow yet still surface (that's the point — the PM
    // discovers which events the app fires). Only a FIRST sighting this process has
    // seen fires the best-effort async upsert; steady state is a pure memory hit and
    // adds NO DB write to the hot path.
    if (this.seen.markSeen(input.accountId, input.eventName)) {
      void this.onUpsert(input.accountId, input.eventName, now).catch(() => {});
    }

    const workflow = this.cache.match(input.accountId, input.eventName);
    if (!workflow) return null;

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
        positive_action: workflow.positiveAction,
        negative_action: workflow.negativeAction,
        skip_enabled: true,
      };
    });
  }
}
