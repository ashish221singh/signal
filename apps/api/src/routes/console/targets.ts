import type { Target } from '@signal/contracts';
import { asc } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../../db/client.js';
import { targetRegistry } from '../../db/schema.js';

/**
 * Console target read route (M2, Task 7). Mounted under the guarded
 * `/v1/console` subtree at prefix `/targets`. Returns all targets ordered by
 * name, mapped from Drizzle camelCase columns to the snake_case wire contract.
 */
export function targetRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async () => {
      const rows = await deps.db.select().from(targetRegistry).orderBy(asc(targetRegistry.name));
      return rows.map(
        (r): Target => ({
          id: r.id,
          name: r.name,
          screen_id: r.screenId,
          trigger_mechanism: r.triggerMechanism,
          integration_status: r.integrationStatus,
        }),
      );
    });
  };
}
