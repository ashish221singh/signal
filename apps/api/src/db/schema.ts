// apps/api/src/db/schema.ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const triggerMechanismEnum = pgEnum('trigger_mechanism', ['action', 'dwell']);
export const integrationStatusEnum = pgEnum('integration_status', [
  'not_sent',
  'sent_to_engineering',
  'confirmed_live',
]);
export const metricTypeEnum = pgEnum('metric_type', ['CSAT', 'CES']);
export const ratingTypeEnum = pgEnum('rating_type', ['star', 'emoji', 'effort_scale']);
export const onPositiveActionEnum = pgEnum('on_positive_action', ['none', 'play_store_review']);
export const askFrequencyEnum = pgEnum('ask_frequency', [
  'after_7_days',
  'after_30_days',
  'after_60_days',
]);
export const campaignStatusEnum = pgEnum('campaign_status', [
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_key_unique').on(t.key),
    index('api_keys_account_idx').on(t.accountId),
  ],
);

export const targetRegistry = pgTable(
  'target_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    screenId: text('screen_id').notNull(),
    triggerMechanism: triggerMechanismEnum('trigger_mechanism').notNull(),
    integrationStatus: integrationStatusEnum('integration_status').notNull().default('not_sent'),
  },
  // screen_id is unique PER ACCOUNT now (B1-D6), not globally.
  (t) => [uniqueIndex('target_registry_account_screen_unique').on(t.accountId, t.screenId)],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    targetId: uuid('target_id').references(() => targetRegistry.id),
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
    minTenureDays: integer('min_tenure_days'),
    status: campaignStatusEnum('status').notNull().default('draft'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_status_target_idx').on(t.status, t.targetId),
    index('campaigns_account_idx').on(t.accountId),
    // B1-D6: the active-complete CHECK drops its `client_ids >= 1` clause.
    check(
      'campaigns_active_complete',
      sql`
        ${t.status} <> 'active' OR (
          ${t.targetId} IS NOT NULL AND ${t.metricType} IS NOT NULL AND ${t.ratingType} IS NOT NULL
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
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    lastShownAt: timestamp('last_shown_at', { withTimezone: true }).notNull(),
    lastAction: lastActionEnum('last_action'),
    nextEligibleAt: timestamp('next_eligible_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.campaignId] })],
);

export const triggerLog = pgTable(
  'trigger_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    userId: text('user_id').notNull(),
    screenId: text('screen_id').notNull(),
    shownAt: timestamp('shown_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('trigger_log_cap_idx').on(t.campaignId, t.userId, t.shownAt)],
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
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    userId: text('user_id').notNull(),
    screenId: text('screen_id').notNull(),
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
    repTenureDays: integer('rep_tenure_days'),
    shownAt: timestamp('shown_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('responses_trigger_id_unique').on(t.triggerId),
    index('responses_reporting_idx').on(t.campaignId, t.respondedAt),
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
