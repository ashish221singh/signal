// apps/api/test/schema.int.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema.js';
import { seedAccount, startTestDb } from './testDb.js';

describe('schema', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let accountId: string;
  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.truncateAll();
    accountId = await seedAccount(t.db);
  });

  async function seedActiveWorkflow(
    overrides: Partial<typeof s.workflows.$inferInsert> = {},
  ): Promise<typeof s.workflows.$inferSelect> {
    const [row] = await t.db
      .insert(s.workflows)
      .values({
        accountId,
        eventName: 'checkout_completed',
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'How was it?',
        positiveThreshold: 4,
        chipsOnNegative: ['Slow'],
        askFrequency: 'after_7_days',
        status: 'active',
        createdBy: 'test',
        ...overrides,
      })
      .returning();
    if (!row) throw new Error('workflow seed returned no row');
    return row;
  }

  it('accepts a full account-scoped row cycle (account → workflow → trigger)', async () => {
    const workflow = await seedActiveWorkflow();
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({
        accountId,
        workflowId: workflow.id,
        userId: 'u_1',
        eventName: 'checkout_completed',
        context: 'OrderSummaryScreen',
        shownAt: new Date(),
      })
      .returning();
    expect(trigger!.id).toMatch(/[0-9a-f-]{36}/);
    expect(trigger!.accountId).toBe(accountId);
    expect(trigger!.eventName).toBe('checkout_completed');
    expect(trigger!.context).toBe('OrderSummaryScreen');
  });

  it('publishable keys are unique across accounts', async () => {
    const other = await seedAccount(t.db, 'Other');
    await t.db
      .insert(s.apiKeys)
      .values({ accountId, key: 'pk_test_dupe', label: 'a', environment: 'test' });
    await expect(
      t.db
        .insert(s.apiKeys)
        .values({ accountId: other, key: 'pk_test_dupe', label: 'b', environment: 'test' }),
    ).rejects.toThrow();
  });

  it('api_keys default allowed_origins to an empty array', async () => {
    const [row] = await t.db
      .insert(s.apiKeys)
      .values({ accountId, key: 'pk_test_origins', label: 'a', environment: 'test' })
      .returning();
    expect(row!.allowedOrigins).toEqual([]);
  });

  // B2-D3: partial unique index — at most one ACTIVE workflow per (account, event).
  it('rejects a second ACTIVE workflow on the same (account, event_name)', async () => {
    await seedActiveWorkflow({ eventName: 'checkout_completed' });
    await expect(seedActiveWorkflow({ eventName: 'checkout_completed' })).rejects.toThrow();
  });

  it('allows a second ACTIVE workflow on a DIFFERENT event_name', async () => {
    await seedActiveWorkflow({ eventName: 'checkout_completed' });
    const second = await seedActiveWorkflow({ eventName: 'customer_created' });
    expect(second.status).toBe('active');
  });

  it('the same (account, event_name) may repeat across NON-active workflows', async () => {
    await seedActiveWorkflow({ eventName: 'checkout_completed', status: 'draft' });
    const paused = await seedActiveWorkflow({ eventName: 'checkout_completed', status: 'paused' });
    expect(paused.status).toBe('paused');
  });

  it('the same event_name is reusable across different accounts', async () => {
    await seedActiveWorkflow({ eventName: 'checkout_completed' });
    const other = await seedAccount(t.db, 'Other');
    const [row] = await t.db
      .insert(s.workflows)
      .values({
        accountId: other,
        eventName: 'checkout_completed',
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'h',
        positiveThreshold: 4,
        askFrequency: 'after_7_days',
        status: 'active',
        createdBy: 'test',
      })
      .returning();
    expect(row!.status).toBe('active');
  });

  // B2-D2: the active-complete CHECK now also requires event_name.
  it('rejects an ACTIVE workflow with a NULL event_name (CHECK)', async () => {
    await expect(
      t.db.insert(s.workflows).values({
        accountId,
        // eventName omitted -> NULL -> CHECK violation for status=active
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'h',
        positiveThreshold: 4,
        status: 'active',
        createdBy: 'test',
      }),
    ).rejects.toThrow();
  });

  // B3-D6: `key` is unique per account (partial index, WHERE key IS NOT NULL).
  it('rejects a second workflow with the same (account, key)', async () => {
    await t.db
      .insert(s.workflows)
      .values({ accountId, key: 'checkout-csat', managedBy: 'code', createdBy: 'deploy' });
    await expect(
      t.db
        .insert(s.workflows)
        .values({ accountId, key: 'checkout-csat', managedBy: 'code', createdBy: 'deploy' }),
    ).rejects.toThrow();
  });

  it('allows many workflows with a NULL key (partial index skips them)', async () => {
    await t.db.insert(s.workflows).values({ accountId, createdBy: 'console' });
    const [row] = await t.db
      .insert(s.workflows)
      .values({ accountId, createdBy: 'console' })
      .returning();
    expect(row!.key).toBeNull();
    expect(row!.managedBy).toBe('console');
  });

  it('the same key is reusable across different accounts', async () => {
    await t.db.insert(s.workflows).values({ accountId, key: 'k', createdBy: 'deploy' });
    const other = await seedAccount(t.db, 'Other');
    const [row] = await t.db
      .insert(s.workflows)
      .values({ accountId: other, key: 'k', createdBy: 'deploy' })
      .returning();
    expect(row!.key).toBe('k');
  });

  // B3-D1: cli_tokens hash is globally unique.
  it('rejects a second cli_token with the same token_hash', async () => {
    await t.db
      .insert(s.cliTokens)
      .values({ accountId, tokenHash: 'h', name: 'a', expiresAt: new Date(Date.now() + 1000) });
    await expect(
      t.db
        .insert(s.cliTokens)
        .values({ accountId, tokenHash: 'h', name: 'b', expiresAt: new Date(Date.now() + 1000) }),
    ).rejects.toThrow();
  });

  it('cli_tokens default scopes to an empty array', async () => {
    const [row] = await t.db
      .insert(s.cliTokens)
      .values({ accountId, tokenHash: 'h2', name: 'a', expiresAt: new Date(Date.now() + 1000) })
      .returning();
    expect(row!.scopes).toEqual([]);
    expect(row!.revokedAt).toBeNull();
  });

  // B3-D3: device_authorizations user_code + device_code_hash are unique.
  it('rejects a duplicate device user_code', async () => {
    await t.db.insert(s.deviceAuthorizations).values({
      deviceCodeHash: 'd1',
      userCode: 'ABCD-1234',
      expiresAt: new Date(Date.now() + 1000),
    });
    await expect(
      t.db.insert(s.deviceAuthorizations).values({
        deviceCodeHash: 'd2',
        userCode: 'ABCD-1234',
        expiresAt: new Date(Date.now() + 1000),
      }),
    ).rejects.toThrow();
  });

  it('device_authorizations default to pending with a null account_id', async () => {
    const [row] = await t.db
      .insert(s.deviceAuthorizations)
      .values({
        deviceCodeHash: 'd3',
        userCode: 'WXYZ-9999',
        expiresAt: new Date(Date.now() + 1000),
      })
      .returning();
    expect(row!.status).toBe('pending');
    expect(row!.accountId).toBeNull();
  });

  // B3-D7: seen_events PK is (account_id, event_name).
  it('rejects a duplicate (account, event_name) in seen_events', async () => {
    await t.db.insert(s.seenEvents).values({ accountId, eventName: 'checkout_completed' });
    await expect(
      t.db.insert(s.seenEvents).values({ accountId, eventName: 'checkout_completed' }),
    ).rejects.toThrow();
  });

  it('rejects a second response for the same trigger_id (unique constraint)', async () => {
    const workflow = await seedActiveWorkflow();
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({
        accountId,
        workflowId: workflow.id,
        userId: 'u',
        eventName: 'checkout_completed',
        shownAt: new Date(),
      })
      .returning();
    const row = {
      accountId,
      triggerId: trigger!.id,
      workflowId: workflow.id,
      userId: 'u',
      eventName: 'checkout_completed',
      ratingValue: 5,
      deviceOs: 'Android',
      appVersion: '1',
      shownAt: new Date(),
      respondedAt: new Date(),
    };
    await t.db.insert(s.responses).values(row);
    await expect(t.db.insert(s.responses).values(row)).rejects.toThrow();
  });
});
