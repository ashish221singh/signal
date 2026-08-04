// apps/api/test/accounts.int.test.ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PUBLISHABLE_KEY_PATTERN } from '../src/accounts/key.js';
import { AccountsService } from '../src/accounts/service.js';
import * as s from '../src/db/schema.js';
import { startTestDb } from './testDb.js';

describe('AccountsService (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let service: AccountsService;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.truncateAll();
    service = new AccountsService(t.db);
  });

  it('signup creates account + admin user + a live key in one tx', async () => {
    const result = await service.signup({
      email: 'owner@example.com',
      password: 'password8',
      name: 'Owner',
      accountName: 'Acme',
    });

    expect(result.account.name).toBe('Acme');
    expect(result.user.email).toBe('owner@example.com');
    expect(result.user.role).toBe('admin');
    expect(result.user.accountId).toBe(result.account.id);
    expect(result.publishableKey).toMatch(/^pk_live_[A-Za-z0-9]{24}$/);
    expect(PUBLISHABLE_KEY_PATTERN.test(result.publishableKey)).toBe(true);

    const accts = await t.db.select().from(s.accounts);
    const users = await t.db.select().from(s.consoleUsers);
    const keys = await t.db.select().from(s.apiKeys);
    expect(accts).toHaveLength(1);
    expect(users).toHaveLength(1);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.environment).toBe('live');
    expect(keys[0]!.accountId).toBe(result.account.id);
  });

  it('duplicate email rejects and rolls back the whole tx (no orphan account)', async () => {
    await service.signup({
      email: 'dupe@example.com',
      password: 'password8',
      name: 'First',
      accountName: 'First Co',
    });
    await expect(
      service.signup({
        email: 'dupe@example.com',
        password: 'password8',
        name: 'Second',
        accountName: 'Second Co',
      }),
    ).rejects.toThrow();

    // The failed signup must not have created a second account or key.
    expect(await t.db.select().from(s.accounts)).toHaveLength(1);
    expect(await t.db.select().from(s.apiKeys)).toHaveLength(1);
  });

  it('lookupAccountByKey resolves a live key, misses on unknown/revoked', async () => {
    const { account, publishableKey } = await service.signup({
      email: 'k@example.com',
      password: 'password8',
      name: 'K',
      accountName: 'K Co',
    });

    expect(await service.lookupAccountByKey(publishableKey)).toBe(account.id);
    expect(await service.lookupAccountByKey('pk_live_unknownunknownunknown0')).toBeNull();

    await service.revokeKey(publishableKey);
    expect(await service.lookupAccountByKey(publishableKey)).toBeNull();

    const [row] = await t.db.select().from(s.apiKeys).where(eq(s.apiKeys.key, publishableKey));
    expect(row!.revokedAt).not.toBeNull();
  });

  it('issueKey adds a second (test) key to the same account', async () => {
    const account = await service.createAccount('Multi');
    const first = await service.issueKey(account.id, 'live');
    const second = await service.issueKey(account.id, 'test', 'ci');
    expect(first.environment).toBe('live');
    expect(second.environment).toBe('test');
    expect(second.label).toBe('ci');
    expect(await service.lookupAccountByKey(first.key)).toBe(account.id);
    expect(await service.lookupAccountByKey(second.key)).toBe(account.id);
  });
});
