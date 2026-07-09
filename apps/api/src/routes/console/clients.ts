import type { Client } from '@signal/contracts';
import { asc } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../../db/client.js';
import { clients } from '../../db/schema.js';

/**
 * Console client read route (M2, Task 7). Mounted under the guarded
 * `/v1/console` subtree at prefix `/clients`. Returns all clients ordered by
 * name, mapped to the wire contract shape.
 */
export function clientRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async () => {
      const rows = await deps.db.select().from(clients).orderBy(asc(clients.name));
      return rows.map(
        (r): Client => ({
          id: r.id,
          name: r.name,
          status: r.status,
        }),
      );
    });
  };
}
