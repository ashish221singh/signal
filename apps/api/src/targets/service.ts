import type { Target, TargetCreate } from '@signal/contracts';
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
  async create(input: TargetCreate): Promise<CreateTargetResult> {
    const screenId = slugify(input.name);
    if (screenId === '') {
      return { ok: false, reason: 'invalid_body' };
    }

    const [row] = await this.db
      .insert(targetRegistry)
      .values({
        name: input.name,
        screenId,
        triggerMechanism: input.trigger_mechanism,
      })
      .onConflictDoNothing({ target: targetRegistry.screenId })
      .returning();

    if (!row) {
      return { ok: false, reason: 'slug_conflict' };
    }
    return { ok: true, target: toTarget(row) };
  }
}
