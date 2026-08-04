import { z } from 'zod';
import {
  askFrequencySchema,
  metricTypeSchema,
  onPositiveActionSchema,
  ratingTypeSchema,
  workflowStatusSchema,
} from '../primitives.js';

/**
 * Agentic-backend contracts (B3): CLI tokens, the device-authorization grant,
 * config-as-code deploy, and event surfacing. These back the CLI (`@signal/cli`)
 * and the MCP server (`@signal/mcp`), which are HTTP-only clients of the console
 * API — so the wire shapes live here and are shared by both sides.
 */

const timestampSchema = z.union([z.date(), z.iso.datetime()]);

/**
 * Scopes (B3-D2): a CLI token carries a subset of these; each route asserts the
 * scope it needs. Least-privilege-ready — today device-flow mints all four, but
 * routes gate per scope so tightening later is free.
 */
export const cliScopeSchema = z.enum([
  'workflows:read',
  'workflows:write',
  'responses:read',
  'deploy',
]);
export type CliScope = z.infer<typeof cliScopeSchema>;

/** All scopes — issued by device-flow and interim password login. */
export const ALL_CLI_SCOPES: readonly CliScope[] = [
  'workflows:read',
  'workflows:write',
  'responses:read',
  'deploy',
] as const;

/** Matches a well-formed CLI token: `cli_<32 base62>` (B3-D1). */
export const CLI_TOKEN_PATTERN = /^cli_[A-Za-z0-9]{32}$/;

// ── CLI tokens ───────────────────────────────────────────────────────────────

/** POST /v1/console/cli-tokens body — mint a token (session-only). */
export const cliTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(cliScopeSchema).nonempty().optional(),
});
export type CliTokenCreate = z.infer<typeof cliTokenCreateSchema>;

/** A CLI token's metadata (the plaintext token is NEVER returned by list). */
export const cliTokenSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(cliScopeSchema),
  created_at: timestampSchema,
  last_used_at: timestampSchema.nullable(),
  expires_at: timestampSchema,
  revoked_at: timestampSchema.nullable(),
});
export type CliToken = z.infer<typeof cliTokenSchema>;

/** POST /v1/console/cli-tokens response — the ONLY time the plaintext appears. */
export const cliTokenCreatedSchema = cliTokenSchema.extend({
  token: z.string(),
});
export type CliTokenCreated = z.infer<typeof cliTokenCreatedSchema>;

// ── Device flow (B3-D3) ──────────────────────────────────────────────────────

/** POST /v1/cli/device/code response — the OAuth device-grant handshake. */
export const deviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  interval: z.int().positive(),
  expires_in: z.int().positive(),
});
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>;

/** POST /v1/cli/device/token body — the CLI polls with the device_code. */
export const deviceTokenRequestSchema = z.object({
  device_code: z.string().min(1),
});
export type DeviceTokenRequest = z.infer<typeof deviceTokenRequestSchema>;

/** POST /v1/cli/device/token success — the token, returned exactly once. */
export const deviceTokenResponseSchema = z.object({
  token: z.string(),
  scopes: z.array(cliScopeSchema),
  expires_at: timestampSchema,
});
export type DeviceTokenResponse = z.infer<typeof deviceTokenResponseSchema>;

// ── Interim password login (B3-D4) ───────────────────────────────────────────

/** POST /v1/cli/login body — email+password → CLI token (prod-gated). */
export const cliLoginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type CliLoginRequest = z.infer<typeof cliLoginRequestSchema>;

/** POST /v1/cli/login response — same token shape the device flow returns. */
export const cliLoginResponseSchema = deviceTokenResponseSchema;
export type CliLoginResponse = z.infer<typeof cliLoginResponseSchema>;

// ── config-as-code deploy (B3-D6) ────────────────────────────────────────────

const eventNameSchema = z.string().min(1).max(200);
const samplingRateSchema = z.number().min(0).max(1);
/** A deploy `key` — the stable per-account identity for the upsert. */
const workflowKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._-]+$/, 'key must be url/path-safe');

/**
 * One workflow in a deploy payload. `key` is the stable identity; `status` chooses
 * the desired lifecycle (`draft` leaves it unpublished; `active` publishes; `paused`
 * publishes-then-pauses). Content fields mirror the console workflow builder and are
 * required to reach `active` — completeness is enforced server-side per item.
 */
export const deployWorkflowSchema = z.object({
  key: workflowKeySchema,
  event_name: eventNameSchema,
  status: z.enum(['draft', 'active', 'paused']).default('active'),
  sampling_rate: samplingRateSchema.optional(),
  metric_type: metricTypeSchema.optional(),
  rating_type: ratingTypeSchema.optional(),
  rating_scale_max: z.int().positive().optional(),
  header_text: z.string().min(1).optional(),
  positive_threshold: z.int().positive().optional(),
  chips_on_negative: z.array(z.string()).optional(),
  other_requires_text: z.boolean().optional(),
  other_allows_image: z.boolean().optional(),
  on_positive_action: onPositiveActionSchema.optional(),
  ask_frequency: askFrequencySchema.optional(),
  min_session_age_days: z.int().nonnegative().nullable().optional(),
});
export type DeployWorkflow = z.infer<typeof deployWorkflowSchema>;

/** POST /v1/console/deploy body. Keys must be unique within the payload. */
export const deployRequestSchema = z.object({
  workflows: z.array(deployWorkflowSchema),
});
export type DeployRequest = z.infer<typeof deployRequestSchema>;

/** Per-item outcome of a deploy (B3-D6 / GR-5: partial success is reported). */
export const deployItemResultSchema = z.object({
  key: z.string(),
  action: z.enum(['created', 'updated', 'unchanged', 'pruned', 'failed']),
  workflow_id: z.uuid().nullable(),
  status: workflowStatusSchema.nullable(),
  // Present when `action === 'failed'`. `event_conflict` names the incumbent.
  error: z
    .object({
      code: z.enum(['event_conflict', 'incomplete', 'invalid']),
      message: z.string(),
      conflict: z
        .object({ id: z.uuid(), header: z.string().nullable(), event_name: z.string().nullable() })
        .optional(),
      missing: z.array(z.string()).optional(),
    })
    .nullable(),
});
export type DeployItemResult = z.infer<typeof deployItemResultSchema>;

/** POST /v1/console/deploy response — one result per applied/pruned item. */
export const deployResponseSchema = z.object({
  results: z.array(deployItemResultSchema),
});
export type DeployResponse = z.infer<typeof deployResponseSchema>;

// ── Event surfacing (B3-D7) ──────────────────────────────────────────────────

/** One surfaced event (GET /v1/console/events). */
export const seenEventSchema = z.object({
  event_name: z.string(),
  first_seen_at: timestampSchema,
  last_seen_at: timestampSchema,
  hit_count: z.int(),
});
export type SeenEvent = z.infer<typeof seenEventSchema>;

/** GET /v1/console/events response. */
export const seenEventListSchema = z.object({
  events: z.array(seenEventSchema),
});
export type SeenEventList = z.infer<typeof seenEventListSchema>;
