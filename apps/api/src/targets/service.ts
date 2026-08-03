import type { IntegrationStatus, Target, TargetCreate } from '@signal/contracts';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { targetRegistry } from '../db/schema.js';
import { slugify } from './slug.js';

type TargetRow = typeof targetRegistry.$inferSelect;

/** Map a Drizzle row (camelCase) to the snake_case `targetSchema` wire shape. */
function toTarget(r: TargetRow): Target {
  return {
    id: r.id,
    name: r.name,
    screen_id: r.screenId,
    trigger_mechanism: r.triggerMechanism,
    integration_status: r.integrationStatus,
  };
}

/**
 * Discriminated outcome of `create` so the route maps to 201 / 422:
 * - `invalid_body`: the name has no sluggable characters (empty slug). Not a
 *   collision, so it is surfaced as an invalid body, not a conflict.
 * - `slug_conflict`: the derived `screen_id` already exists. No auto-suffix
 *   (M2-D13) — a silent `order_completion_2` would poison SDK integration.
 */
export type CreateTargetResult =
  | { ok: true; target: Target }
  | { ok: false; reason: 'slug_conflict' | 'invalid_body' };

/**
 * Discriminated outcome of `setIntegrationStatus` so the route maps to
 * 200 / 404 / 422:
 * - `not_found`: no target with that id.
 * - `illegal_transition`: the `from → to` move is not in the M2-D17 table.
 */
export type SetIntegrationStatusResult =
  | { ok: true; target: Target }
  | { ok: false; reason: 'not_found' | 'illegal_transition' };

/**
 * Legal integration-status transitions (M2-D17). A move is legal iff `to` is
 * listed under its `from`. Encoded as an explicit table (not scattered
 * conditionals) so the rule reads at a glance:
 * - `not_sent → sent_to_engineering` — the "mark as sent to engineering" action.
 * - `* → confirmed_live` — manual confirm from ANY state (M2-D17), which makes a
 *   `confirmed_live → confirmed_live` re-confirm an idempotent no-op (200).
 * Everything else — the other same-state no-ops (`not_sent → not_sent`,
 * `sent_to_engineering → sent_to_engineering`) and any backward move — is illegal.
 */
const LEGAL_TRANSITIONS: Record<IntegrationStatus, readonly IntegrationStatus[]> = {
  not_sent: ['sent_to_engineering', 'confirmed_live'],
  sent_to_engineering: ['confirmed_live'],
  confirmed_live: ['confirmed_live'],
};

function isLegalTransition(from: IntegrationStatus, to: IntegrationStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Console-side target service (M2, Task 14). Backs the guarded
 * `/v1/console/targets` create route. The GET list stays in the route (Task 7);
 * this service minimally adds `create`.
 */
export class TargetService {
  constructor(private readonly db: Db) {}

  /**
   * Insert a target with a server-side slug (M2-D13). `screen_id = slugify(name)`.
   * An empty slug (name is all punctuation) → `invalid_body`. Otherwise insert
   * with `onConflictDoNothing` on the unique `screen_id`; an empty `.returning()`
   * means the slug already existed → `slug_conflict` (no auto-suffix).
   */
  async create(accountId: string, input: TargetCreate): Promise<CreateTargetResult> {
    const screenId = slugify(input.name);
    if (screenId === '') {
      return { ok: false, reason: 'invalid_body' };
    }

    const [row] = await this.db
      .insert(targetRegistry)
      .values({
        accountId,
        name: input.name,
        screenId,
        triggerMechanism: input.trigger_mechanism,
      })
      // screen_id is unique per (account, screen_id) now; a same-account collision
      // does nothing and returns no row → slug_conflict.
      .onConflictDoNothing({
        target: [targetRegistry.accountId, targetRegistry.screenId],
      })
      .returning();

    if (!row) {
      return { ok: false, reason: 'slug_conflict' };
    }
    return { ok: true, target: toTarget(row) };
  }

  /**
   * Transition a target's `integration_status` (Task 15, M2-D17). Loads the
   * target (404 → `not_found`), validates the move against `LEGAL_TRANSITIONS`
   * (illegal → `illegal_transition`, no write), then persists and returns the
   * updated target. No `updatedAt` on `target_registry` — nothing else changes.
   */
  async setIntegrationStatus(
    accountId: string,
    id: string,
    to: IntegrationStatus,
  ): Promise<SetIntegrationStatusResult> {
    const [current] = await this.db
      .select()
      .from(targetRegistry)
      .where(and(eq(targetRegistry.id, id), eq(targetRegistry.accountId, accountId)));
    if (!current) {
      return { ok: false, reason: 'not_found' };
    }

    if (!isLegalTransition(current.integrationStatus, to)) {
      return { ok: false, reason: 'illegal_transition' };
    }

    const [row] = await this.db
      .update(targetRegistry)
      .set({ integrationStatus: to })
      .where(and(eq(targetRegistry.id, id), eq(targetRegistry.accountId, accountId)))
      .returning();
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }
    return { ok: true, target: toTarget(row) };
  }
}
