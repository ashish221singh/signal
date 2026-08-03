// apps/api/src/db/schema.ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// B2-D1: the `trigger_mechanism` and `integration_status` enums are dropped —
// screens/targets are no longer a targeting concept; a named event is the trigger.
export const metricTypeEnum = pgEnum('metric_type', ['CSAT', 'CES']);
export const ratingTypeEnum = pgEnum('rating_type', ['star', 'emoji', 'effort_scale']);
export const onPositiveActionEnum = pgEnum('on_positive_action', ['none', 'play_store_review']);
export const askFrequencyEnum = pgEnum('ask_frequency', [
  'after_7_days',
  'after_30_days',
  'after_60_days',
]);
// The status enum keeps its Postgres type name for the reused lifecycle logic.
export const workflowStatusEnum = pgEnum('workflow_status', [
  'draft',
  'active',
  'paused',
  'archived',
]);
export const lastActionEnum = pgEnum('last_action', ['dismissed', 'submitted']);
export const consoleUserRoleEnum = pgEnum('console_user_role', ['admin', 'editor']);
export const apiKeyEnvironmentEnum = pgEnum('api_key_environment', ['live', 'test']);

/**
 * Accounts (B1-D2): the tenant root. Every owned row FK-references an account.
 * A single-owner model in B1 — one admin console user per account, no
 * memberships table (YAGNI until teams).
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Publishable API keys (B1-D3): NOT secrets. Stored plaintext and unique-indexed
 * for O(1) key→account lookup on the SDK hot path. Format `pk_<env>_<base62(24)>`.
 * Multiple keys per account allowed; `revoked_at` supports downtime-free rotation.
 *
 * B2-D7: `allowed_origins` is the per-account browser origin allow-list — enforced
 * only when an `Origin` header is present (native SDKs send none and pass). Empty
 * (the default) means "no browser restriction".
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    key: text('key').notNull(),
    label: text('label').notNull(),
    environment: apiKeyEnvironmentEnum('environment').notNull(),
    allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_key_unique').on(t.key),
    index('api_keys_account_idx').on(t.accountId),
  ],
);

/**
 * Workflows (B2-D1, was `campaigns`): a workflow listens for a named `event_name`
 * and, when eligible, presents a CSAT/CES ask. `target_registry` and the target
 * axis are gone (B2-D1); an optional free-form `context` travels on eligibility
 * for debugging only.
 *
 * - `event_name` (B2-D2): required when `status='active'` (in the CHECK).
 * - `sampling_rate` (B2-D2): 0–1 probability the ask fires after the other gates.
 * - `min_session_age_days` (B2-D2, renamed from `min_tenure_days`): the session-age gate.
 * - one active workflow per (account_id, event_name): partial unique index (B2-D3).
 */
export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    eventName: text('event_name'),
    samplingRate: numeric('sampling_rate', { precision: 4, scale: 3 }).notNull().default('1.000'),
    metricType: metricTypeEnum('metric_type'),
    ratingType: ratingTypeEnum('rating_type'),
    ratingScaleMax: integer('rating_scale_max'),
    headerText: text('header_text'),
    positiveThreshold: integer('positive_threshold'),
    chipsOnNegative: jsonb('chips_on_negative')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    otherRequiresText: boolean('other_requires_text').notNull().default(true),
    otherAllowsImage: boolean('other_allows_image').notNull().default(false),
    onPositiveAction: onPositiveActionEnum('on_positive_action').notNull().default('none'),
    askFrequency: askFrequencyEnum('ask_frequency').notNull().default('after_7_days'),
    minSessionAgeDays: integer('min_session_age_days'),
    status: workflowStatusEnum('status').notNull().default('draft'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workflows_account_idx').on(t.accountId),
    // B2-D3: at most one ACTIVE workflow per (account, event). Draft/paused/archived
    // rows are unconstrained; the runtime tie-break (oldest created_at) still guards
    // any transient overlap the partial index cannot catch.
    uniqueIndex('workflows_active_event_unique')
      .on(t.accountId, t.eventName)
      .where(sql`${t.status} = 'active'`),
    // B2-D2: the active-complete CHECK now also requires `event_name`.
    check(
      'workflows_active_complete',
      sql`
        ${t.status} <> 'active' OR (
          ${t.eventName} IS NOT NULL AND ${t.metricType} IS NOT NULL AND ${t.ratingType} IS NOT NULL
          AND ${t.ratingScaleMax} IS NOT NULL AND ${t.headerText} IS NOT NULL
          AND ${t.positiveThreshold} IS NOT NULL
        )
      `,
    ),
  ],
);

export const suppressionState = pgTable(
  'suppression_state',
  {
    userId: text('user_id').notNull(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id),
    lastShownAt: timestamp('last_shown_at', { withTimezone: true }).notNull(),
    lastAction: lastActionEnum('last_action'),
    nextEligibleAt: timestamp('next_eligible_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workflowId] })],
);

export const triggerLog = pgTable(
  'trigger_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id),
    userId: text('user_id').notNull(),
    // B2-D9: reporting groups by event; `context` is retained for drill-down only.
    eventName: text('event_name').notNull(),
    context: text('context'),
    shownAt: timestamp('shown_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('trigger_log_cap_idx').on(t.workflowId, t.userId, t.shownAt)],
);

export const responses = pgTable(
  'responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    triggerId: uuid('trigger_id')
      .notNull()
      .references(() => triggerLog.id),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id),
    userId: text('user_id').notNull(),
    eventName: text('event_name').notNull(),
    context: text('context'),
    ratingValue: integer('rating_value').notNull(),
    chipSelected: text('chip_selected'),
    otherText: text('other_text'),
    otherImageUrl: text('other_image_url'),
    location: jsonb('location').$type<{
      lat: number;
      lng: number;
      state?: string;
      country?: string;
    }>(),
    deviceOs: text('device_os').notNull(),
    appVersion: text('app_version').notNull(),
    sessionAgeDays: integer('session_age_days'),
    shownAt: timestamp('shown_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('responses_trigger_id_unique').on(t.triggerId),
    index('responses_reporting_idx').on(t.workflowId, t.respondedAt),
  ],
);

export const consoleUsers = pgTable('console_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  // email stays globally unique (B1-D10): one owner, one account, simple login lookup.
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: consoleUserRoleEnum('role').notNull().default('admin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
