// apps/api/src/scripts/seed-dev.ts
// Idempotent dev seed. Safe to re-run: clients/targets are upserted, and seed
// campaigns (createdBy = 'seed') are deleted then reinserted. Child tables that
// FK-reference campaigns are cleared first so re-runs stay clean on a
// disposable dev DB. Run with: pnpm --filter @signal/api seed
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import * as schema from '../db/schema.js';
import { parseEnv } from '../env.js';

const SEED_CREATED_BY = 'seed';

const CLIENTS = [
  { id: 'cl_A', name: 'Acme Distribution', status: 'active' as const },
  { id: 'cl_B', name: 'Bharat FMCG', status: 'active' as const },
  { id: 'cl_X', name: 'Churned Co', status: 'inactive' as const },
];

const TARGETS = [
  {
    name: 'Order Completion',
    screenId: 'order_completion',
    triggerMechanism: 'action' as const,
    integrationStatus: 'confirmed_live' as const,
  },
  {
    name: 'New Customer Creation',
    screenId: 'new_customer_creation',
    triggerMechanism: 'action' as const,
    integrationStatus: 'confirmed_live' as const,
  },
  {
    name: 'Goal Monitoring Page',
    screenId: 'goal_monitoring_page',
    triggerMechanism: 'dwell' as const,
    integrationStatus: 'confirmed_live' as const,
  },
];

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const { db, close } = createDb(env.DATABASE_URL);

  try {
    // 1. Upsert clients.
    for (const client of CLIENTS) {
      await db
        .insert(schema.clients)
        .values(client)
        .onConflictDoUpdate({
          target: schema.clients.id,
          set: { name: client.name, status: client.status },
        });
    }

    // 2. Upsert targets (keyed on the unique screenId).
    for (const target of TARGETS) {
      await db
        .insert(schema.targetRegistry)
        .values(target)
        .onConflictDoUpdate({
          target: schema.targetRegistry.screenId,
          set: {
            name: target.name,
            triggerMechanism: target.triggerMechanism,
            integrationStatus: target.integrationStatus,
          },
        });
    }

    // Resolve target ids by screenId.
    const targetRows = await db.select().from(schema.targetRegistry);
    const targetIdByScreen = new Map(targetRows.map((t) => [t.screenId, t.id]));
    const targetId = (screenId: string): string => {
      const id = targetIdByScreen.get(screenId);
      if (id === undefined) {
        throw new Error(`Seed target missing for screenId: ${screenId}`);
      }
      return id;
    };

    // 3. Clear child tables (FK-safe order) then delete prior seed campaigns.
    // On a disposable dev DB this keeps re-runs idempotent and duplicate-free.
    await db.delete(schema.responses);
    await db.delete(schema.triggerLog);
    await db.delete(schema.suppressionState);
    await db.delete(schema.campaigns).where(eq(schema.campaigns.createdBy, SEED_CREATED_BY));

    // 4. Insert the four demo campaigns.
    const inserted = await db
      .insert(schema.campaigns)
      .values([
        {
          // Star / 7-day cooldown — the flagship CSAT campaign with a play-store nudge.
          targetId: targetId('order_completion'),
          clientIds: ['cl_A', 'cl_B'],
          metricType: 'CSAT',
          ratingType: 'star',
          ratingScaleMax: 5,
          headerText: 'How satisfied were you with placing this order?',
          positiveThreshold: 4,
          chipsOnNegative: ['Slow to load', 'Items hard to find', 'Sync failed'],
          onPositiveAction: 'play_store_review',
          askFrequency: 'after_7_days',
          status: 'active',
          createdBy: SEED_CREATED_BY,
        },
        {
          // Emoji / 7-day cooldown — occupies new_customer_creation x cl_A.
          targetId: targetId('new_customer_creation'),
          clientIds: ['cl_A'],
          metricType: 'CSAT',
          ratingType: 'emoji',
          ratingScaleMax: 3,
          headerText: 'How was creating this customer?',
          positiveThreshold: 3,
          chipsOnNegative: ['Confusing form', 'Missing fields', 'Too slow'],
          askFrequency: 'after_7_days',
          status: 'active',
          createdBy: SEED_CREATED_BY,
        },
        {
          // Effort(3) / 30-day cooldown — CES on a dwell target.
          targetId: targetId('goal_monitoring_page'),
          clientIds: ['cl_A'],
          metricType: 'CES',
          ratingType: 'effort_scale',
          ratingScaleMax: 3,
          headerText: 'How easy was reaching your goal view?',
          positiveThreshold: 2,
          chipsOnNegative: ['Hard to navigate', 'Data unclear', 'Took too long'],
          askFrequency: 'after_30_days',
          status: 'active',
          createdBy: SEED_CREATED_BY,
        },
        {
          // Star / 7-day cooldown with a tenure gate — cl_B on new_customer_creation
          // (cl_A is already taken there by the emoji campaign, so one active
          // campaign per (target, client) is respected).
          targetId: targetId('new_customer_creation'),
          clientIds: ['cl_B'],
          metricType: 'CSAT',
          ratingType: 'star',
          ratingScaleMax: 5,
          headerText: 'How satisfied were you? (tenured)',
          positiveThreshold: 4,
          chipsOnNegative: ['Slow to load', 'Items hard to find', 'Sync failed'],
          minTenureDays: 90,
          askFrequency: 'after_7_days',
          status: 'active',
          createdBy: SEED_CREATED_BY,
        },
      ])
      .returning();

    // 5. Print a table for curl use.
    const screenByTargetId = new Map(targetRows.map((t) => [t.id, t.screenId]));
    const table = inserted.map((c) => ({
      id: c.id,
      screenId: (c.targetId && screenByTargetId.get(c.targetId)) ?? '(unknown)',
      clientIds: c.clientIds.join(','),
      ratingType: c.ratingType,
      askFrequency: c.askFrequency,
    }));
    console.table(table);
  } finally {
    // 6. Always close the connection.
    await close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  },
);
