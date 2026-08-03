// apps/api/src/scripts/seed-dev.ts
// Idempotent dev seed (B2). Bootstraps ONE dev account (`Signal Dev`) with an
// admin user (admin@signal.dev / password: devpassword) and a `pk_test_*`
// publishable key, then sample event-keyed workflows under that account. Safe to
// re-run: the account/user/key are upserted by their natural keys, and seed
// workflows (createdBy = 'seed') are cleared then reinserted on a disposable dev
// DB. Prints the publishable key + a curl-ready workflow table.
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

    // 4. Clear child tables (FK-safe order) then delete prior seed workflows.
    await db.delete(schema.responses).where(eq(schema.responses.accountId, accountId));
    await db.delete(schema.triggerLog).where(eq(schema.triggerLog.accountId, accountId));
    // suppression_state has no account_id; clear rows for this account's workflows.
    const seedWorkflowIds = (
      await db
        .select({ id: schema.workflows.id })
        .from(schema.workflows)
        .where(eq(schema.workflows.accountId, accountId))
    ).map((r) => r.id);
    for (const wid of seedWorkflowIds) {
      await db.delete(schema.suppressionState).where(eq(schema.suppressionState.workflowId, wid));
    }
    await db
      .delete(schema.workflows)
      .where(
        and(
          eq(schema.workflows.accountId, accountId),
          eq(schema.workflows.createdBy, SEED_CREATED_BY),
        ),
      );

    // 5. Insert the demo workflows (one active per event — B2-D3 uniqueness rule).
    const inserted = await db
      .insert(schema.workflows)
      .values([
        {
          accountId,
          eventName: 'checkout_completed',
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
          eventName: 'customer_created',
          metricType: 'CSAT',
          ratingType: 'emoji',
          ratingScaleMax: 3,
          headerText: 'How was creating this customer?',
          positiveThreshold: 3,
          chipsOnNegative: ['Confusing form', 'Missing fields', 'Too slow'],
          askFrequency: 'after_7_days',
          minSessionAgeDays: 90,
          status: 'active',
          createdBy: SEED_CREATED_BY,
        },
        {
          accountId,
          eventName: 'goal_viewed',
          samplingRate: '0.500',
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

    // 6. Print the key + a workflow table for curl use.
    console.log(`Dev account:     ${account.name} (${accountId})`);
    console.log(`Admin login:     ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    console.log(`Publishable key: ${publishableKey}`);
    console.table(
      inserted.map((w) => ({
        id: w.id,
        eventName: w.eventName,
        ratingType: w.ratingType,
        samplingRate: w.samplingRate,
        askFrequency: w.askFrequency,
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
