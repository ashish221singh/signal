import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { TokenService } from '../src/tokens/service.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

/**
 * User-data deletion (B4-D6): DELETE /v1/console/users/:userId/data
 * transactionally removes that user's responses/trigger_log/suppression_state
 * WITHIN the caller's account only. Scoped to `workflows:write`.
 */
const env = parseEnv({ NODE_ENV: 'test' });

async function seedWorkflow(db: Db, accountId: string): Promise<string> {
  const [row] = await db
    .insert(s.workflows)
    .values({
      accountId,
      eventName: `evt_${Math.random().toString(36).slice(2, 8)}`,
      metricType: 'CSAT',
      ratingType: 'star',
      ratingScaleMax: 5,
      headerText: 'How was it?',
      positiveThreshold: 4,
      status: 'active',
      createdBy: 'seed',
    })
    .returning();
  return row!.id;
}

/** Seed a full response chain (trigger + response + suppression) for a user. */
async function seedUserData(
  db: Db,
  accountId: string,
  workflowId: string,
  userId: string,
): Promise<void> {
  const [trigger] = await db
    .insert(s.triggerLog)
    .values({ accountId, workflowId, userId, eventName: 'e', shownAt: new Date() })
    .returning();
  await db.insert(s.responses).values({
    accountId,
    triggerId: trigger!.id,
    workflowId,
    userId,
    eventName: 'e',
    ratingValue: 5,
    deviceOs: 'Android',
    appVersion: '1',
    shownAt: new Date(),
    respondedAt: new Date(),
  });
  await db.insert(s.suppressionState).values({
    userId,
    workflowId,
    lastShownAt: new Date(),
    lastAction: 'submitted',
    nextEligibleAt: null,
  });
}

async function counts(db: Db, accountId: string, userId: string) {
  const r = await db
    .select()
    .from(s.responses)
    .where(and(eq(s.responses.accountId, accountId), eq(s.responses.userId, userId)));
  const t = await db
    .select()
    .from(s.triggerLog)
    .where(and(eq(s.triggerLog.accountId, accountId), eq(s.triggerLog.userId, userId)));
  // suppression_state has no account_id; scope it to the account's workflows so
  // this helper counts only the account's own suppression rows.
  const accountWorkflowIds = (
    await db
      .select({ id: s.workflows.id })
      .from(s.workflows)
      .where(eq(s.workflows.accountId, accountId))
  ).map((w) => w.id);
  const supp =
    accountWorkflowIds.length === 0
      ? []
      : await db
          .select()
          .from(s.suppressionState)
          .where(
            and(
              eq(s.suppressionState.userId, userId),
              inArray(s.suppressionState.workflowId, accountWorkflowIds),
            ),
          );
  return { responses: r.length, trigger_log: t.length, suppression_state: supp.length };
}

describe('DELETE /v1/console/users/:userId/data (real Postgres)', () => {
  let dbh: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;

  beforeAll(async () => {
    dbh = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await dbh.stop();
  });

  beforeEach(async () => {
    await dbh.truncateAll();
    const seeded = await seedAccountWithUser(dbh.db);
    accountId = seeded.accountId;
    app = await buildApp(env, { db: dbh.db, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(seeded.userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('no credential → 401', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/console/users/u_1/data' });
    expect(res.statusCode).toBe(401);
  });

  it('a read-only token (workflows:read) → 403 insufficient_scope', async () => {
    const { token } = await new TokenService(dbh.db).issue(accountId, 'ci', {
      scopes: ['workflows:read'],
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/console/users/u_1/data',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('deletes only that user within the caller account and reports counts', async () => {
    const wf = await seedWorkflow(dbh.db, accountId);
    await seedUserData(dbh.db, accountId, wf, 'u_target');
    await seedUserData(dbh.db, accountId, wf, 'u_other'); // a different user, must survive

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/console/users/u_target/data',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user_id: 'u_target',
      deleted: { responses: 1, trigger_log: 1, suppression_state: 1 },
    });

    // Target user gone, other user intact.
    expect(await counts(dbh.db, accountId, 'u_target')).toEqual({
      responses: 0,
      trigger_log: 0,
      suppression_state: 0,
    });
    expect(await counts(dbh.db, accountId, 'u_other')).toEqual({
      responses: 1,
      trigger_log: 1,
      suppression_state: 1,
    });
  });

  it("isolation: does NOT touch another account's data for the same user_id", async () => {
    const wfA = await seedWorkflow(dbh.db, accountId);
    await seedUserData(dbh.db, accountId, wfA, 'shared_user');

    const b = await seedAccountWithUser(dbh.db, { accountName: 'B', email: 'b@example.com' });
    const wfB = await seedWorkflow(dbh.db, b.accountId);
    await seedUserData(dbh.db, b.accountId, wfB, 'shared_user');

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/console/users/shared_user/data',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);

    // Account A's copy is gone; account B's identical user_id survives.
    expect(await counts(dbh.db, accountId, 'shared_user')).toEqual({
      responses: 0,
      trigger_log: 0,
      suppression_state: 0,
    });
    expect(await counts(dbh.db, b.accountId, 'shared_user')).toEqual({
      responses: 1,
      trigger_log: 1,
      suppression_state: 1,
    });
  });

  it('a user with no data → 200 with zero counts (idempotent)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/console/users/ghost/data',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toEqual({ responses: 0, trigger_log: 0, suppression_state: 0 });
  });
});
