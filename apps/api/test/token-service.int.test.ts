import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../src/tokens/service.js';
import { CLI_TOKEN_PATTERN } from '../src/tokens/token.js';
import { seedAccount, startTestDb } from './testDb.js';

describe('TokenService (real Postgres)', () => {
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

  it('issues a cli_ token with all scopes by default, verifiable once', async () => {
    const svc = new TokenService(t.db);
    const { token, meta } = await svc.issue(accountId, 'ci');
    expect(CLI_TOKEN_PATTERN.test(token)).toBe(true);
    expect(meta.scopes).toEqual(['workflows:read', 'workflows:write', 'responses:read', 'deploy']);

    const resolved = await svc.verify(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.accountId).toBe(accountId);
  });

  it('stamps last_used_at on verify', async () => {
    const svc = new TokenService(t.db);
    const { token, meta } = await svc.issue(accountId, 'ci');
    expect(meta.last_used_at).toBeNull();
    await svc.verify(token);
    const [row] = await svc.list(accountId);
    expect(row?.last_used_at).not.toBeNull();
  });

  it('honours a narrowed scope set', async () => {
    const svc = new TokenService(t.db);
    const { token } = await svc.issue(accountId, 'ro', { scopes: ['workflows:read'] });
    const resolved = await svc.verify(token);
    expect(resolved?.scopes).toEqual(['workflows:read']);
  });

  it('rejects an unknown token', async () => {
    const svc = new TokenService(t.db);
    expect(await svc.verify('cli_' + 'z'.repeat(32))).toBeNull();
  });

  it('rejects an expired token', async () => {
    const svc = new TokenService(t.db);
    const { token } = await svc.issue(accountId, 'ci', { ttlMs: -1000 });
    expect(await svc.verify(token)).toBeNull();
  });

  it('rejects a revoked token; revoke is idempotent and account-scoped', async () => {
    const svc = new TokenService(t.db);
    const { token, meta } = await svc.issue(accountId, 'ci');
    expect(await svc.revoke(accountId, meta.id)).toBe(true);
    expect(await svc.verify(token)).toBeNull();
    // idempotent-ish: revoking again still matches the row (returns true)
    expect(await svc.revoke(accountId, meta.id)).toBe(true);

    // another account cannot revoke it
    const other = await seedAccount(t.db, 'Other');
    expect(await svc.revoke(other, meta.id)).toBe(false);
  });

  it('isolates list by account', async () => {
    const svc = new TokenService(t.db);
    await svc.issue(accountId, 'mine');
    const other = await seedAccount(t.db, 'Other');
    await svc.issue(other, 'theirs');
    const mine = await svc.list(accountId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.name).toBe('mine');
  });
});
