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
// B3-D1: how a workflow is managed. `console` rows are edited via the console/MCP;
// `code` rows are owned by `signal deploy` (config-as-code) and locked against
// console/MCP edits (B3-D6).
export const workflowManagedByEnum = pgEnum('workflow_managed_by', ['console', 'code']);
// B3-D3: device-authorization lifecycle for the OAuth Device Grant.
export const deviceAuthStatusEnum = pgEnum('device_auth_status', [
  'pending',
  'approved',
  'denied',
  'expired',
]);

/**
 * B5-D1: a branchable post-submit action stored as jsonb on a workflow. The tagged
 * shape `{ type, message?, url? }` is validated/normalized at the contract boundary
 * (`@signal/contracts` `actionSchema`); this is the structural type the column
 * carries. `redirect` uses `url` (https-only); `thanks` uses `message`.
 */
export type WorkflowActionType = 'none' | 'thanks' | 'redirect' | 'store_review';
export interface WorkflowAction {
  type: WorkflowActionType;
  message?: string;
  url?: string;
}
const NONE_ACTION = sql`'{"type":"none"}'::jsonb`;

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
    // B5-D1: branched post-submit actions (replaces the `on_positive_action` enum).
    positiveAction: jsonb('positive_action').$type<WorkflowAction>().notNull().default(NONE_ACTION),
    negativeAction: jsonb('negative_action').$type<WorkflowAction>().notNull().default(NONE_ACTION),
    askFrequency: askFrequencyEnum('ask_frequency').notNull().default('after_7_days'),
    minSessionAgeDays: integer('min_session_age_days'),
    status: workflowStatusEnum('status').notNull().default('draft'),
    // B3-D6: `key` is the stable identity for config-as-code deploy — the upsert
    // target for `(account_id, key)`. NULL for console-created workflows (which
    // have no stable key). `managed_by` gates edits: `code` rows are locked to
    // the deploy path; console/MCP mutations to them are rejected 409.
    key: text('key'),
    managedBy: workflowManagedByEnum('managed_by').notNull().default('console'),
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
    // B3-D6: `key` is unique per account when present — the deploy upsert identity.
    // Partial (WHERE key IS NOT NULL) so the many console rows with NULL key don't
    // collide.
    uniqueIndex('workflows_account_key_unique')
      .on(t.accountId, t.key)
      .where(sql`${t.key} IS NOT NULL`),
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
  // Nullable since F3: Google-OAuth users have no password. A row must have EITHER
  // a password_hash OR a google_sub (enforced by a CHECK in the migration). Password
  // login guards against a null hash and returns the same invalid_credentials 401.
  passwordHash: text('password_hash'),
  // Google's stable subject id (`sub`), the canonical identity link for "Log in with
  // Google" (F3). Unique when present; null for password-only users. We find-or-create
  // by google_sub, falling back to linking an existing account by verified email.
  googleSub: text('google_sub').unique(),
  // Clerk user id (F3, Clerk dashboard login). Unique when present. Same find-or-create
  // (by clerk_user_id → link-by-email → create) as the Google path.
  clerkUserId: text('clerk_user_id').unique(),
  name: text('name').notNull(),
  role: consoleUserRoleEnum('role').notNull().default('admin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * CLI tokens (B3-D1): unlike publishable keys these ARE secrets — a CLI token can
 * mutate. Stored sha256-HASHED (`token_hash`, unique for O(1) lookup); the plaintext
 * `cli_<base62(32)>` is shown once at issue and never persisted. `scopes` gates each
 * route (B3-D2). Default 90d expiry; `revoked_at` supports immediate revocation.
 */
export const cliTokens = pgTable(
  'cli_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('cli_tokens_token_hash_unique').on(t.tokenHash),
    index('cli_tokens_account_idx').on(t.accountId),
  ],
);

/**
 * Device authorizations (B3-D3): the OAuth 2.0 Device Authorization Grant state.
 * The `device_code` is a secret the CLI polls with, so it is stored HASHED; the
 * `user_code` is the short human-typed code shown on the approval page. `account_id`
 * is NULL until an authenticated console user approves (binding the account). The
 * poll endpoint returns the token exactly once when status flips to `approved`.
 */
export const deviceAuthorizations = pgTable(
  'device_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceCodeHash: text('device_code_hash').notNull(),
    userCode: text('user_code').notNull(),
    accountId: uuid('account_id').references(() => accounts.id),
    status: deviceAuthStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('device_authorizations_device_code_hash_unique').on(t.deviceCodeHash),
    uniqueIndex('device_authorizations_user_code_unique').on(t.userCode),
  ],
);

/**
 * Seen events (B3-D7): the surfaced set of `event_name`s an account has ever fired
 * an eligibility check for. Populated OFF the hot path — the eligibility service
 * keeps an in-memory per-account seen-set and only writes here on a first sighting
 * this process hasn't recorded (best-effort async upsert). PK (account_id,
 * event_name); `hit_count` is a coarse counter bumped on each first-sighting upsert.
 */
export const seenEvents = pgTable(
  'seen_events',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    eventName: text('event_name').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    hitCount: integer('hit_count').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.eventName] })],
);
