// apps/api/src/db/schema.ts
import {
  boolean,
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
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'active', 'paused']);
export const lastActionEnum = pgEnum('last_action', ['dismissed', 'submitted']);
export const clientStatusEnum = pgEnum('client_status', ['active', 'inactive']);
export const consoleUserRoleEnum = pgEnum('console_user_role', ['admin', 'editor']);

export const targetRegistry = pgTable('target_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  screenId: text('screen_id').notNull().unique(),
  triggerMechanism: triggerMechanismEnum('trigger_mechanism').notNull(),
  integrationStatus: integrationStatusEnum('integration_status').notNull().default('not_sent'),
});

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targetRegistry.id),
    clientIds: jsonb('client_ids').$type<string[]>().notNull(),
    metricType: metricTypeEnum('metric_type').notNull(),
    ratingType: ratingTypeEnum('rating_type').notNull(),
    ratingScaleMax: integer('rating_scale_max').notNull(),
    headerText: text('header_text').notNull(),
    positiveThreshold: integer('positive_threshold').notNull(),
    chipsOnNegative: jsonb('chips_on_negative').$type<string[]>().notNull(),
    otherRequiresText: boolean('other_requires_text').notNull().default(true),
    otherAllowsImage: boolean('other_allows_image').notNull().default(false),
    onPositiveAction: onPositiveActionEnum('on_positive_action').notNull().default('none'),
    askFrequency: askFrequencyEnum('ask_frequency').notNull(),
    minTenureDays: integer('min_tenure_days'),
    status: campaignStatusEnum('status').notNull().default('draft'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_status_target_idx').on(t.status, t.targetId)],
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
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    userId: text('user_id').notNull(),
    clientId: text('client_id').notNull(),
    screenId: text('screen_id').notNull(),
    shownAt: timestamp('shown_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('trigger_log_cap_idx').on(t.campaignId, t.userId, t.shownAt)],
);

export const responses = pgTable(
  'responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    triggerId: uuid('trigger_id')
      .notNull()
      .references(() => triggerLog.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    userId: text('user_id').notNull(),
    clientId: text('client_id').notNull(),
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

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: clientStatusEnum('status').notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
});

export const consoleUsers = pgTable('console_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: consoleUserRoleEnum('role').notNull().default('admin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
