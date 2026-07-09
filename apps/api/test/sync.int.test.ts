// apps/api/test/sync.int.test.ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clients } from '../src/db/schema.js';
import type { SourceClient } from '../src/sync/beatrouteClient.js';
import { syncClients } from '../src/sync/syncClients.js';
import { startTestDb } from './testDb.js';

const stub =
  (rows: SourceClient[]): (() => Promise<SourceClient[]>) =>
  () =>
    Promise.resolve(rows);

describe('syncClients — idempotent upsert', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  const now = new Date('2026-07-09T12:00:00.000Z');

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.truncateAll();
  });

  it('inserts new clients into an empty table', async () => {
    const summary = await syncClients(
      t.db,
      stub([
        { id: 'cl_A', name: 'Alpha', status: 'active' },
        { id: 'cl_B', name: 'Beta', status: 'active' },
      ]),
      now,
    );

    expect(summary).toEqual({ inserted: 2, updated: 0, deactivated: 0 });

    const rows = await t.db.select().from(clients);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('active');
      expect(r.lastSyncedAt.getTime()).toBe(now.getTime());
    }
  });

  it('updates name and status of an existing client in place', async () => {
    await t.db.insert(clients).values({
      id: 'cl_A',
      name: 'Stale Name',
      status: 'inactive',
      lastSyncedAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    const summary = await syncClients(
      t.db,
      stub([{ id: 'cl_A', name: 'Renamed', status: 'active' }]),
      now,
    );

    expect(summary).toEqual({ inserted: 0, updated: 1, deactivated: 0 });

    const [row] = await t.db.select().from(clients).where(eq(clients.id, 'cl_A'));
    expect(row!.name).toBe('Renamed');
    expect(row!.status).toBe('active');
  });

  it('deactivates a source-absent client but does NOT delete it', async () => {
    await t.db.insert(clients).values({
      id: 'cl_X',
      name: 'Ghost',
      status: 'active',
      lastSyncedAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    const summary = await syncClients(t.db, stub([]), now);

    expect(summary).toEqual({ inserted: 0, updated: 0, deactivated: 1 });

    const [row] = await t.db.select().from(clients).where(eq(clients.id, 'cl_X'));
    expect(row).toBeDefined();
    expect(row!.status).toBe('inactive');
  });

  it('bumps last_synced_at to the provided now for touched rows', async () => {
    await t.db.insert(clients).values({
      id: 'cl_A',
      name: 'Alpha',
      status: 'active',
      lastSyncedAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    await syncClients(t.db, stub([{ id: 'cl_A', name: 'Alpha', status: 'active' }]), now);

    const [row] = await t.db.select().from(clients).where(eq(clients.id, 'cl_A'));
    expect(row!.lastSyncedAt.getTime()).toBe(now.getTime());
  });

  it('leaves the clients cache untouched when the fetcher throws (M4-D9)', async () => {
    await t.db.insert(clients).values({
      id: 'cl_A',
      name: 'Alpha',
      status: 'active',
      lastSyncedAt: new Date('2000-01-01T00:00:00.000Z'),
    });
    const before = await t.db.select().from(clients);

    const boom = (): Promise<SourceClient[]> => Promise.reject(new Error('fetch failed'));

    await expect(syncClients(t.db, boom, now)).rejects.toThrow('fetch failed');

    const after = await t.db.select().from(clients);
    expect(after).toEqual(before);
  });

  it('is idempotent — a second identical sync inserts/deactivates nothing', async () => {
    const source: SourceClient[] = [
      { id: 'cl_A', name: 'Alpha', status: 'active' },
      { id: 'cl_B', name: 'Beta', status: 'active' },
    ];

    const first = await syncClients(t.db, stub(source), now);
    expect(first).toEqual({ inserted: 2, updated: 0, deactivated: 0 });

    const second = await syncClients(t.db, stub(source), now);
    expect(second).toEqual({ inserted: 0, updated: 2, deactivated: 0 });

    const rows = await t.db.select().from(clients);
    expect(rows).toHaveLength(2);
  });
});
