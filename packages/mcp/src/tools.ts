import {
  askFrequencySchema,
  metricTypeSchema,
  onPositiveActionSchema,
  ratingTypeSchema,
} from '@signal/contracts';
import { z } from 'zod';
import type { SignalApiClient } from './client.js';

/**
 * MCP tool definitions (B3-D8). Each tool maps 1:1 to console API calls through the
 * HTTP client, so all validation and account isolation stay server-side. The
 * definitions are transport-agnostic (a plain array) so they can be unit-tested and
 * then registered on the MCP server in `index.ts`.
 *
 * `create_workflow`/`update_workflow` combine the API's create-draft + PATCH steps
 * into one agent-friendly call. `set_rules` targets only the sampling/gating fields.
 */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputShape: S;
  handler: (args: z.infer<z.ZodObject<S>>, client: SignalApiClient) => Promise<unknown>;
}

const workflowContentShape = {
  event_name: z.string().min(1).optional(),
  metric_type: metricTypeSchema.optional(),
  rating_type: ratingTypeSchema.optional(),
  rating_scale_max: z.number().int().positive().optional(),
  header_text: z.string().min(1).optional(),
  positive_threshold: z.number().int().positive().optional(),
  chips_on_negative: z.array(z.string()).optional(),
  other_requires_text: z.boolean().optional(),
  other_allows_image: z.boolean().optional(),
  on_positive_action: onPositiveActionSchema.optional(),
  ask_frequency: askFrequencySchema.optional(),
  sampling_rate: z.number().min(0).max(1).optional(),
  min_session_age_days: z.number().int().nonnegative().nullable().optional(),
};

/** Strip undefined keys so PATCH bodies only carry provided fields. */
function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<z.ZodRawShape> {
  return def as unknown as ToolDef<z.ZodRawShape>;
}

export const TOOLS: ToolDef<z.ZodRawShape>[] = [
  tool({
    name: 'list_workflows',
    description: 'List the account’s workflows (id, event_name, header, status).',
    inputShape: { include_archived: z.boolean().optional() },
    handler: async (args, client) => {
      const q = args.include_archived ? '?include=archived' : '';
      return client.get(`/v1/console/workflows${q}`);
    },
  }),
  tool({
    name: 'get_workflow',
    description: 'Get a single workflow by id.',
    inputShape: { id: z.string().uuid() },
    handler: (args, client) => client.get(`/v1/console/workflows/${args.id}`),
  }),
  tool({
    name: 'create_workflow',
    description:
      'Create a workflow (draft) and set its builder fields in one step. Returns the created workflow.',
    inputShape: workflowContentShape,
    handler: async (args, client) => {
      const created = await client.post<{ id: string }>('/v1/console/workflows', {});
      const patch = definedOnly(args);
      if (Object.keys(patch).length === 0) return created;
      return client.patch(`/v1/console/workflows/${created.id}`, patch);
    },
  }),
  tool({
    name: 'update_workflow',
    description: 'Update a workflow’s builder fields (partial). Returns the updated workflow.',
    inputShape: { id: z.string().uuid(), ...workflowContentShape },
    handler: (args, client) => {
      const { id, ...rest } = args;
      return client.patch(`/v1/console/workflows/${id}`, definedOnly(rest));
    },
  }),
  tool({
    name: 'set_rules',
    description: 'Set a workflow’s targeting rules: sampling_rate and/or min_session_age_days.',
    inputShape: {
      id: z.string().uuid(),
      sampling_rate: z.number().min(0).max(1).optional(),
      min_session_age_days: z.number().int().nonnegative().nullable().optional(),
    },
    handler: (args, client) => {
      const { id, ...rest } = args;
      return client.patch(`/v1/console/workflows/${id}`, definedOnly(rest));
    },
  }),
  tool({
    name: 'publish_workflow',
    description: 'Publish a complete workflow (draft → active).',
    inputShape: { id: z.string().uuid() },
    handler: (args, client) => client.post(`/v1/console/workflows/${args.id}/publish`),
  }),
  tool({
    name: 'pause_workflow',
    description: 'Pause an active workflow (active → paused).',
    inputShape: { id: z.string().uuid() },
    handler: (args, client) => client.post(`/v1/console/workflows/${args.id}/pause`),
  }),
  tool({
    name: 'list_events',
    description: 'List the events the account has fired eligibility checks for.',
    inputShape: {},
    handler: (_args, client) => client.get('/v1/console/events'),
  }),
  tool({
    name: 'get_overview',
    description: 'Get a workflow’s reporting overview (triggers, responses, rates).',
    inputShape: { id: z.string().uuid() },
    handler: (args, client) => client.get(`/v1/console/workflows/${args.id}/overview`),
  }),
  tool({
    name: 'get_responses',
    description: 'Get a workflow’s recent responses feed (cursor-paginated).',
    inputShape: {
      id: z.string().uuid(),
      min_rating: z.number().int().min(1).max(5).optional(),
      max_rating: z.number().int().min(1).max(5).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
    handler: (args, client) => {
      const { id, ...rest } = args;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(definedOnly(rest))) params.set(k, String(v));
      const q = params.toString();
      return client.get(`/v1/console/workflows/${id}/responses${q ? `?${q}` : ''}`);
    },
  }),
];
