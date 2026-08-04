import {
  actionSchema,
  type Workflow,
  type WorkflowDraftCreate,
  type WorkflowListItem,
  type WorkflowUpdate,
} from '@signal/contracts';
import { and, count, desc, eq, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { responses, suppressionState, triggerLog, workflows } from '../db/schema.js';

/**
 * Semantic fields (M2-D9, extended B2-D3): they define the score math or the
 * event key. Once a workflow has ≥1 response, changing them would silently
 * redefine historical scores (or steal an event key), so they are immutable from
 * that point on (route surfaces `semantic_locked`). `event_name` joins the lock
 * (B2: immutable after the first response). All other (operational) fields stay
 * editable regardless.
 */
export const SEMANTIC_FIELDS = [
  'event_name',
  'metric_type',
  'rating_type',
  'rating_scale_max',
  'positive_threshold',
] as const satisfies readonly (keyof WorkflowUpdate)[];

/**
 * `code_managed` (B3-D6): the workflow is owned by `signal deploy` (`managed_by =
 * 'code'`); console/MCP mutations are rejected 409 so config-as-code stays the
 * single source of truth. The route maps it to 409 `code_managed`.
 */
/** Discriminated outcome so the route can map to 200 / 404 / 422 / 409. */
export type UpdateResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; reason: 'not_found' | 'semantic_locked' | 'code_managed' };

/**
 * The columns the DB CHECK (`workflows_active_complete`) requires before a
 * workflow may go `active`. Mirrored in code (M2-D5) so publish can list the
 * *missing* fields in a 422 rather than surfacing a raw CHECK violation.
 * Wire (snake_case) names. `event_name` is required to publish (B2-D2).
 */
export type MissingField =
  | 'event_name'
  | 'metric_type'
  | 'rating_type'
  | 'rating_scale_max'
  | 'header_text'
  | 'positive_threshold';

/** The active workflow a publish would collide with (B2-D3 / one active per event). */
export interface OverlapConflict {
  id: string;
  header: string | null;
  event_name: string | null;
}

/**
 * Discriminated outcome of `publish` so the route can map to
 * 200 / 404 / 422 (incomplete) / 409 (overlap).
 */
/** The action columns a publish re-validates (B5-D2). Wire (snake_case) names. */
export type ActionField = 'positive_action' | 'negative_action';

export type PublishResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; reason: 'not_found' | 'code_managed' }
  | { ok: false; reason: 'incomplete'; missing: MissingField[] }
  | { ok: false; reason: 'invalid_action'; invalid: ActionField[] }
  | { ok: false; reason: 'overlap'; conflict: OverlapConflict };

export type TransitionResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'code_managed' };

export type ResumeResult =
  | { ok: true; workflow: Workflow }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'code_managed' }
  | { ok: false; reason: 'overlap'; conflict: OverlapConflict };

export type RemoveResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'has_history' | 'code_managed' };

/**
 * Console-side workflow service (B2). Every read and write is scoped by
 * `account_id` (B1-D8): a workflow is only visible/mutable to its owning account,
 * and new rows are stamped with the account. Distinct from the SDK-side
 * `workflows/cache.ts`/`loader.ts` (the eligibility hot path — not touched here).
 */
export type WorkflowRow = typeof workflows.$inferSelect;

/** Map a Drizzle row (camelCase) to the snake_case `workflowSchema` wire shape. */
export function toWorkflow(r: WorkflowRow): Workflow {
  return {
    id: r.id,
    event_name: r.eventName,
    // numeric(4,3) comes back as a string; the wire contract is a number.
    sampling_rate: Number(r.samplingRate),
    metric_type: r.metricType,
    rating_type: r.ratingType,
    rating_scale_max: r.ratingScaleMax,
    header_text: r.headerText,
    positive_threshold: r.positiveThreshold,
    chips_on_negative: r.chipsOnNegative,
    other_requires_text: r.otherRequiresText,
    other_allows_image: r.otherAllowsImage,
    positive_action: r.positiveAction,
    negative_action: r.negativeAction,
    ask_frequency: r.askFrequency,
    min_session_age_days: r.minSessionAgeDays,
    status: r.status,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/**
 * Collect the wire (snake_case) names of the completeness fields a row is
 * missing, mirroring the `workflows_active_complete` DB CHECK. Empty array ⇒ the
 * row is publishable.
 */
export function missingRequiredFields(r: WorkflowRow): MissingField[] {
  const missing: MissingField[] = [];
  if (r.eventName === null) missing.push('event_name');
  if (r.metricType === null) missing.push('metric_type');
  if (r.ratingType === null) missing.push('rating_type');
  if (r.ratingScaleMax === null) missing.push('rating_scale_max');
  if (r.headerText === null) missing.push('header_text');
  if (r.positiveThreshold === null) missing.push('positive_threshold');
  return missing;
}

/**
 * B5-D2: re-validate the stored branched actions at publish (defense in depth — the
 * contract already validates on every write). A structurally invalid action (e.g. a
 * `redirect` with no/HTTP url that somehow reached the row) blocks going active.
 * Returns the wire names of the offending action columns; empty ⇒ both are well-formed.
 */
export function invalidActionFields(r: WorkflowRow): ActionField[] {
  const invalid: ActionField[] = [];
  if (!actionSchema.safeParse(r.positiveAction).success) invalid.push('positive_action');
  if (!actionSchema.safeParse(r.negativeAction).success) invalid.push('negative_action');
  return invalid;
}

export class WorkflowService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Insert a minimal draft row owned by `accountId` and `createdBy`. */
  async create(
    accountId: string,
    createdBy: string,
    _body: WorkflowDraftCreate,
  ): Promise<Workflow> {
    const [row] = await this.db.insert(workflows).values({ accountId, createdBy }).returning();
    if (!row) throw new Error('workflow insert returned no row');
    return toWorkflow(row);
  }

  async getById(accountId: string, id: string): Promise<Workflow | null> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .limit(1);
    return row ? toWorkflow(row) : null;
  }

  /**
   * Partial update of a draft's builder fields, scoped to `accountId`. Unknown id
   * (or another account's id) → `not_found`. If the patch touches ANY semantic
   * field AND the workflow already has ≥1 response → `semantic_locked` (no write).
   * Otherwise apply only the provided keys and stamp `updatedAt`.
   */
  async update(accountId: string, id: string, patch: WorkflowUpdate): Promise<UpdateResult> {
    const existing = await this.db
      .select({ id: workflows.id, managedBy: workflows.managedBy })
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .limit(1);
    if (existing.length === 0) return { ok: false, reason: 'not_found' };
    // B3-D6: code-managed workflows are edited only via `signal deploy`.
    if (existing[0]?.managedBy === 'code') return { ok: false, reason: 'code_managed' };

    const touchesSemantic = SEMANTIC_FIELDS.some((f) => f in patch);
    if (touchesSemantic) {
      const [row] = await this.db
        .select({ n: count() })
        .from(responses)
        .where(and(eq(responses.workflowId, id), eq(responses.accountId, accountId)));
      if ((row?.n ?? 0) > 0) return { ok: false, reason: 'semantic_locked' };
    }

    const set: Partial<typeof workflows.$inferInsert> = { updatedAt: this.clock.now() };
    if ('event_name' in patch) set.eventName = patch.event_name;
    if ('sampling_rate' in patch) set.samplingRate = String(patch.sampling_rate);
    if ('metric_type' in patch) set.metricType = patch.metric_type;
    if ('rating_type' in patch) set.ratingType = patch.rating_type;
    if ('rating_scale_max' in patch) set.ratingScaleMax = patch.rating_scale_max;
    if ('header_text' in patch) set.headerText = patch.header_text;
    if ('positive_threshold' in patch) set.positiveThreshold = patch.positive_threshold;
    if ('chips_on_negative' in patch) set.chipsOnNegative = patch.chips_on_negative;
    if ('other_requires_text' in patch) set.otherRequiresText = patch.other_requires_text;
    if ('other_allows_image' in patch) set.otherAllowsImage = patch.other_allows_image;
    if ('positive_action' in patch) set.positiveAction = patch.positive_action;
    if ('negative_action' in patch) set.negativeAction = patch.negative_action;
    if ('ask_frequency' in patch) set.askFrequency = patch.ask_frequency;
    if ('min_session_age_days' in patch) set.minSessionAgeDays = patch.min_session_age_days;

    const [updated] = await this.db
      .update(workflows)
      .set(set)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, workflow: toWorkflow(updated) };
  }

  /**
   * Publish a draft, scoped to `accountId`: validate completeness in code, reject
   * an overlapping active workflow on the same `event_name` within the account
   * (B2-D3), then flip `status = 'active'`.
   */
  async publish(accountId: string, id: string): Promise<PublishResult> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.managedBy === 'code') return { ok: false, reason: 'code_managed' };

    const missing = missingRequiredFields(row);
    if (missing.length > 0) return { ok: false, reason: 'incomplete', missing };

    // B5-D2: a workflow may not go active with a malformed action.
    const invalid = invalidActionFields(row);
    if (invalid.length > 0) return { ok: false, reason: 'invalid_action', invalid };

    // `eventName` is guaranteed non-null here (completeness passed above).
    const conflict = await this.findActiveOverlap(accountId, id, row.eventName as string);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const [updated] = await this.db
      .update(workflows)
      .set({ status: 'active', updatedAt: this.clock.now() })
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, workflow: toWorkflow(updated) };
  }

  /** Pause an ACTIVE workflow → `paused`, scoped to `accountId`. */
  async pause(accountId: string, id: string): Promise<TransitionResult> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.managedBy === 'code') return { ok: false, reason: 'code_managed' };
    if (row.status !== 'active') return { ok: false, reason: 'invalid_state' };

    const [updated] = await this.db
      .update(workflows)
      .set({ status: 'paused', updatedAt: this.clock.now() })
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, workflow: toWorkflow(updated) };
  }

  /**
   * Resume a PAUSED workflow → `active`, scoped to `accountId`. Re-runs the same
   * active-overlap check publish uses (B2-D3).
   */
  async resume(accountId: string, id: string): Promise<ResumeResult> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.managedBy === 'code') return { ok: false, reason: 'code_managed' };
    if (row.status !== 'paused') return { ok: false, reason: 'invalid_state' };

    const conflict = await this.findActiveOverlap(accountId, id, row.eventName as string);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const [updated] = await this.db
      .update(workflows)
      .set({ status: 'active', updatedAt: this.clock.now() })
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, workflow: toWorkflow(updated) };
  }

  /** Archive a workflow → `archived` from any non-archived state. */
  async archive(accountId: string, id: string): Promise<TransitionResult> {
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.managedBy === 'code') return { ok: false, reason: 'code_managed' };
    if (row.status === 'archived') return { ok: false, reason: 'invalid_state' };

    const [updated] = await this.db
      .update(workflows)
      .set({ status: 'archived', updatedAt: this.clock.now() })
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, workflow: toWorkflow(updated) };
  }

  /**
   * Hard delete a workflow row, scoped to `accountId`. Only a `draft` with ZERO
   * trigger/response/suppression history is deletable (M2-D6).
   */
  async remove(accountId: string, id: string): Promise<RemoveResult> {
    const [row] = await this.db
      .select({ status: workflows.status, managedBy: workflows.managedBy })
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.managedBy === 'code') return { ok: false, reason: 'code_managed' };

    if (row.status !== 'draft') {
      return { ok: false, reason: 'has_history' };
    }

    const [trig] = await this.db
      .select({ n: count() })
      .from(triggerLog)
      .where(eq(triggerLog.workflowId, id));
    const [resp] = await this.db
      .select({ n: count() })
      .from(responses)
      .where(eq(responses.workflowId, id));
    const [supp] = await this.db
      .select({ n: count() })
      .from(suppressionState)
      .where(eq(suppressionState.workflowId, id));
    if ((trig?.n ?? 0) > 0 || (resp?.n ?? 0) > 0 || (supp?.n ?? 0) > 0) {
      return { ok: false, reason: 'has_history' };
    }

    await this.db
      .delete(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.accountId, accountId)));
    return { ok: true };
  }

  /**
   * Find an ACTIVE workflow in the account on `eventName`, excluding `excludeId`.
   * One active workflow per (account, event) is the B2-D3 rule. Ties break to the
   * oldest `created_at`. Returns the first match or null.
   */
  private async findActiveOverlap(
    accountId: string,
    excludeId: string,
    eventName: string,
  ): Promise<OverlapConflict | null> {
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

  /**
   * List workflows for the account ordered by `updatedAt desc`. Excludes archived
   * unless `includeArchived` (M2-D6).
   */
  async list(
    accountId: string,
    { includeArchived }: { includeArchived: boolean },
  ): Promise<WorkflowListItem[]> {
    const statusCond = includeArchived ? undefined : ne(workflows.status, 'archived');
    const rows = await this.db
      .select({
        id: workflows.id,
        event_name: workflows.eventName,
        header_text: workflows.headerText,
        status: workflows.status,
        updated_at: workflows.updatedAt,
      })
      .from(workflows)
      .where(
        statusCond
          ? and(eq(workflows.accountId, accountId), statusCond)
          : eq(workflows.accountId, accountId),
      )
      .orderBy(desc(workflows.updatedAt));

    return rows.map((r) => ({
      id: r.id,
      event_name: r.event_name,
      header_text: r.header_text,
      status: r.status,
      updated_at: r.updated_at,
    }));
  }
}
