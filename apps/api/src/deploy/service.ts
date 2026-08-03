import type { DeployItemResult, DeployRequest, DeployWorkflow } from '@signal/contracts';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { workflows } from '../db/schema.js';
import { missingRequiredFields, type WorkflowRow } from '../workflows/service.js';

/**
 * config-as-code deploy (B3-D6, GR-5). Applies a declarative `{ workflows: [...] }`
 * payload for one account:
 *
 * - Upsert by `(account_id, key)`: create a code-managed workflow, or update the
 *   existing one. `managed_by` is set to `'code'`.
 * - Desired `status` drives lifecycle: `draft` leaves it unpublished; `active`
 *   publishes (after a completeness + event-uniqueness check); `paused` publishes-
 *   then-pauses.
 * - PRUNE: any `managed_by='code'` workflow whose key is ABSENT from the payload is
 *   ARCHIVED (never hard-deleted).
 * - Event-uniqueness (B2-D3): an item whose event already has a DIFFERENT active
 *   workflow fails with `event_conflict` (naming the incumbent). The rest of the
 *   deploy still applies — PARTIAL SUCCESS is reported per item.
 *
 * Each item is applied independently (its own try) so one failure never aborts the
 * others. Idempotent: re-running the same payload yields `unchanged` for settled
 * items.
 */
type DeployItem = DeployWorkflow;

/** Build the column set for an insert/update from a deploy item's content fields. */
function contentValues(item: DeployItem): Partial<typeof workflows.$inferInsert> {
  const set: Partial<typeof workflows.$inferInsert> = {};
  if (item.sampling_rate !== undefined) set.samplingRate = String(item.sampling_rate);
  if (item.metric_type !== undefined) set.metricType = item.metric_type;
  if (item.rating_type !== undefined) set.ratingType = item.rating_type;
  if (item.rating_scale_max !== undefined) set.ratingScaleMax = item.rating_scale_max;
  if (item.header_text !== undefined) set.headerText = item.header_text;
  if (item.positive_threshold !== undefined) set.positiveThreshold = item.positive_threshold;
  if (item.chips_on_negative !== undefined) set.chipsOnNegative = item.chips_on_negative;
  if (item.other_requires_text !== undefined) set.otherRequiresText = item.other_requires_text;
  if (item.other_allows_image !== undefined) set.otherAllowsImage = item.other_allows_image;
  if (item.on_positive_action !== undefined) set.onPositiveAction = item.on_positive_action;
  if (item.ask_frequency !== undefined) set.askFrequency = item.ask_frequency;
  if (item.min_session_age_days !== undefined) set.minSessionAgeDays = item.min_session_age_days;
  return set;
}

/** Did any content/event field actually differ from the stored row? */
function rowDiffersFromItem(row: WorkflowRow, item: DeployItem): boolean {
  if (row.eventName !== item.event_name) return true;
  const desired = contentValues(item);
  if (desired.samplingRate !== undefined && row.samplingRate !== desired.samplingRate) return true;
  if (desired.metricType !== undefined && row.metricType !== desired.metricType) return true;
  if (desired.ratingType !== undefined && row.ratingType !== desired.ratingType) return true;
  if (desired.ratingScaleMax !== undefined && row.ratingScaleMax !== desired.ratingScaleMax)
    return true;
  if (desired.headerText !== undefined && row.headerText !== desired.headerText) return true;
  if (
    desired.positiveThreshold !== undefined &&
    row.positiveThreshold !== desired.positiveThreshold
  )
    return true;
  if (
    desired.chipsOnNegative !== undefined &&
    JSON.stringify(row.chipsOnNegative) !== JSON.stringify(desired.chipsOnNegative)
  )
    return true;
  if (
    desired.otherRequiresText !== undefined &&
    row.otherRequiresText !== desired.otherRequiresText
  )
    return true;
  if (desired.otherAllowsImage !== undefined && row.otherAllowsImage !== desired.otherAllowsImage)
    return true;
  if (desired.onPositiveAction !== undefined && row.onPositiveAction !== desired.onPositiveAction)
    return true;
  if (desired.askFrequency !== undefined && row.askFrequency !== desired.askFrequency) return true;
  if (
    desired.minSessionAgeDays !== undefined &&
    row.minSessionAgeDays !== desired.minSessionAgeDays
  )
    return true;
  return false;
}

const desiredDbStatus = (s: DeployItem['status']): 'draft' | 'active' | 'paused' => s;

export class DeployService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async deploy(accountId: string, payload: DeployRequest): Promise<DeployItemResult[]> {
    const results: DeployItemResult[] = [];
    const seenKeys = new Set<string>();

    for (const item of payload.workflows) {
      seenKeys.add(item.key);
      try {
        results.push(await this.applyItem(accountId, item));
      } catch (err) {
        results.push({
          key: item.key,
          action: 'failed',
          workflow_id: null,
          status: null,
          error: {
            code: 'invalid',
            message: err instanceof Error ? err.message : 'deploy item failed',
          },
        });
      }
    }

    // Prune: archive code-managed workflows whose key is absent from the payload.
    const codeManaged = await this.db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.accountId, accountId),
          eq(workflows.managedBy, 'code'),
          isNotNull(workflows.key),
        ),
      );
    for (const row of codeManaged) {
      if (row.key && !seenKeys.has(row.key) && row.status !== 'archived') {
        await this.db
          .update(workflows)
          .set({ status: 'archived', updatedAt: this.clock.now() })
          .where(eq(workflows.id, row.id));
        results.push({
          key: row.key,
          action: 'pruned',
          workflow_id: row.id,
          status: 'archived',
          error: null,
        });
      }
    }

    return results;
  }

  private async applyItem(accountId: string, item: DeployItem): Promise<DeployItemResult> {
    const now = this.clock.now();
    const [existing] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.accountId, accountId), eq(workflows.key, item.key)))
      .limit(1);

    let row: WorkflowRow;
    let action: DeployItemResult['action'];

    if (!existing) {
      const [inserted] = await this.db
        .insert(workflows)
        .values({
          accountId,
          key: item.key,
          managedBy: 'code',
          eventName: item.event_name,
          status: 'draft',
          createdBy: 'deploy',
          ...contentValues(item),
        })
        .returning();
      if (!inserted) throw new Error('deploy insert returned no row');
      row = inserted;
      action = 'created';
    } else {
      const differs = rowDiffersFromItem(existing, item);
      if (differs) {
        const [updated] = await this.db
          .update(workflows)
          .set({ eventName: item.event_name, ...contentValues(item), updatedAt: now })
          .where(eq(workflows.id, existing.id))
          .returning();
        if (!updated) throw new Error('deploy update returned no row');
        row = updated;
        action = 'updated';
      } else {
        row = existing;
        action = 'unchanged';
      }
    }

    // Apply the desired lifecycle status.
    const desired = desiredDbStatus(item.status);
    const statusOutcome = await this.applyStatus(accountId, row, desired);
    if (!statusOutcome.ok) {
      return {
        key: item.key,
        action: 'failed',
        workflow_id: row.id,
        status: statusOutcome.status,
        error: statusOutcome.error,
      };
    }

    // Idempotency: only a genuine no-op (content unchanged AND status unchanged)
    // reports `unchanged`. If content matched but the status moved, report `updated`.
    let finalAction: DeployItemResult['action'] = action;
    if (action === 'unchanged') {
      finalAction = statusOutcome.changed ? 'updated' : 'unchanged';
    }

    return {
      key: item.key,
      action: finalAction,
      workflow_id: row.id,
      status: statusOutcome.status,
      error: null,
    };
  }

  /**
   * Drive `row` to the desired status, honouring the B2-D3 one-active-per-event
   * rule. Returns `changed` = whether the DB status actually moved.
   */
  private async applyStatus(
    accountId: string,
    row: WorkflowRow,
    desired: 'draft' | 'active' | 'paused',
  ): Promise<
    | { ok: true; status: 'draft' | 'active' | 'paused'; changed: boolean }
    | { ok: false; status: WorkflowRow['status']; error: NonNullable<DeployItemResult['error']> }
  > {
    if (desired === 'draft') {
      if (row.status === 'draft') return { ok: true, status: 'draft', changed: false };
      await this.setStatus(row.id, 'draft');
      return { ok: true, status: 'draft', changed: true };
    }

    // active or paused both require completeness + a free event slot to publish.
    const missing = missingRequiredFields(row);
    if (missing.length > 0) {
      return {
        ok: false,
        status: row.status,
        error: {
          code: 'incomplete',
          message: 'workflow is missing required fields to publish',
          missing,
        },
      };
    }

    const conflict = await this.findActiveOverlap(accountId, row.id, row.eventName as string);
    if (conflict) {
      return {
        ok: false,
        status: row.status,
        error: {
          code: 'event_conflict',
          message: `event '${row.eventName}' is already served by an active workflow`,
          conflict,
        },
      };
    }

    if (desired === 'active') {
      if (row.status === 'active') return { ok: true, status: 'active', changed: false };
      await this.setStatus(row.id, 'active');
      return { ok: true, status: 'active', changed: true };
    }

    // paused: publish-then-pause (or straight to paused). No active row exists on
    // this event (checked above), so paused is always reachable.
    if (row.status === 'paused') return { ok: true, status: 'paused', changed: false };
    await this.setStatus(row.id, 'paused');
    return { ok: true, status: 'paused', changed: true };
  }

  private async setStatus(id: string, status: 'draft' | 'active' | 'paused'): Promise<void> {
    await this.db
      .update(workflows)
      .set({ status, updatedAt: this.clock.now() })
      .where(eq(workflows.id, id));
  }

  /**
   * Find an ACTIVE workflow in the account on `eventName`, excluding `excludeId`
   * (B2-D3). Names the incumbent for an `event_conflict`. Ties break oldest-first.
   */
  private async findActiveOverlap(
    accountId: string,
    excludeId: string,
    eventName: string,
  ): Promise<{ id: string; header: string | null; event_name: string | null } | null> {
    const [conflict] = await this.db
      .select({
        id: workflows.id,
        header: workflows.headerText,
        event_name: workflows.eventName,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.accountId, accountId),
          eq(workflows.status, 'active'),
          eq(workflows.eventName, eventName),
          ne(workflows.id, excludeId),
        ),
      )
      .orderBy(workflows.createdAt)
      .limit(1);
    return conflict ?? null;
  }
}
