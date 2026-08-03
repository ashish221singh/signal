// apps/api/src/scripts/seed-dev.ts
// Idempotent dev seed (B1). Bootstraps ONE dev account (`Signal Dev`) with an
// admin user (admin@signal.dev / password: devpassword) and a `pk_test_*`
// publishable key, then the sample campaigns under that account. Safe to re-run:
// the account/user/key are upserted by their natural keys, and seed campaigns
// (createdBy = 'seed') are cleared then reinserted on a disposable dev DB.
// Prints the publishable key + a curl-ready campaign table.
// Run with: pnpm --filter @signal/api seed
import { and, eq } from 'drizzle-orm';
import { generateKey } from '../accounts/key.js';
import { hashPassword } from '../auth/password.js';
import { createDb } from '../db/client.js';
import * as schema from '../db/schema.js';
import { parseEnv } from '../env.js';

const SEED_CREATED_BY = 'seed';
const ACCOUNT_NAME = 'Signal Dev';
const ADMIN_EMAIL = 'admin@signal.dev';
const ADMIN_NAME = 'Signal Dev Admin';
const ADMIN_PASSWORD = 'devpassword';

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
    // 1. Upsert the dev account (keyed by name — good enough for a single dev row).
    let [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.name, ACCOUNT_NAME))
      .limit(1);
    if (!account) {
      [account] = await db.insert(schema.accounts).values({ name: ACCOUNT_NAME }).returning();
    }
    if (!account) throw new Error('failed to create dev account');
    const accountId = account.id;

    // 2. Upsert the admin user (email globally unique).
    await db
      .insert(schema.consoleUsers)
      .values({
        accountId,
        email: ADMIN_EMAIL,
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        name: ADMIN_NAME,
        role: 'admin',
      })
      .onConflictDoUpdate({
        target: schema.consoleUsers.email,
        set: { name: ADMIN_NAME },
      });

    // 3. Ensure exactly one active pk_test key for this account (rotate-free reuse).
    const existingKeys = await db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.accountId, accountId), eq(schema.apiKeys.environment, 'test')));
    let publishableKey = existingKeys.find((k) => k.revokedAt === null)?.key;
    if (!publishableKey) {
      publishableKey = generateKey('test');
      await db.insert(schema.apiKeys).values({
        accountId,
        key: publishableKey,
        label: 'dev',
        environment: 'test',
      });
    }

    // 4. Upsert targets (keyed on the unique (account, screenId)).
    for (const target of TARGETS) {
      await db
        .insert(schema.targetRegistry)
        .values({ accountId, ...target })
        .onConflictDoUpdate({
          target: [schema.targetRegistry.accountId, schema.targetRegistry.screenId],
          set: {
            name: target.name,
            triggerMechanism: target.triggerMechanism,
            integrationStatus: target.integrationStatus,
          },
        });
    }

    const targetRows = await db
      .select()
      .from(schema.targetRegistry)
      .where(eq(schema.targetRegistry.accountId, accountId));
    const targetIdByScreen = new Map(targetRows.map((t) => [t.screenId, t.id]));
    const targetId = (screenId: string): string => {
      const id = targetIdByScreen.get(screenId);
      if (id === undefined) throw new Error(`Seed target missing for screenId: ${screenId}`);
      return id;
    };

    // 5. Clear child tables (FK-safe order) then delete prior seed campaigns.
    await db.delete(schema.responses).where(eq(schema.responses.accountId, accountId));
    await db.delete(schema.triggerLog).where(eq(schema.triggerLog.accountId, accountId));
    // suppression_state has no account_id; clear rows for this account's campaigns.
    const seedCampaignIds = (
      await db
        .select({ id: schema.campaigns.id })
        .from(schema.campaigns)
        .where(eq(schema.campaigns.accountId, accountId))
    ).map((r) => r.id);
    for (const cid of seedCampaignIds) {
      await db.delete(schema.suppressionState).where(eq(schema.suppressionState.campaignId, cid));
    }
    await db
      .delete(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.accountId, accountId),
          eq(schema.campaigns.createdBy, SEED_CREATED_BY),
        ),
      );

    // 6. Insert the demo campaigns (one active per target — B1 uniqueness rule).
    const inserted = await db
      .insert(schema.campaigns)
      .values([
        {
          accountId,
          targetId: targetId('order_completion'),
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
          accountId,
          targetId: targetId('new_customer_creation'),
          metricType: 'CSAT',
          ratingType: 'emoji',
          ratingScaleMax: 3,
          headerText: 'How was creating this customer?',
          positiveThreshold: 3,
          chipsOnNegative: ['Confusing form', 'Missing fields', 'Too slow'],
          askFrequency: 'after_7_days',
          minTenureDays: 90,
          status: 'active',
          createdBy: SEED_CREATED_BY,
        },
        {
          accountId,
          targetId: targetId('goal_monitoring_page'),
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
      ])
      .returning();

    // 7. Print the key + a campaign table for curl use.
    const screenByTargetId = new Map(targetRows.map((t) => [t.id, t.screenId]));
    console.log(`Dev account:     ${account.name} (${accountId})`);
    console.log(`Admin login:     ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    console.log(`Publishable key: ${publishableKey}`);
    console.table(
      inserted.map((c) => ({
        id: c.id,
        screenId: (c.targetId && screenByTargetId.get(c.targetId)) ?? '(unknown)',
        ratingType: c.ratingType,
        askFrequency: c.askFrequency,
      })),
    );
  } finally {
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
