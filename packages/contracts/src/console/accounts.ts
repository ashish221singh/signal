import { z } from 'zod';

/**
 * Signup contracts (B1-D2, B1-D10). Open, rate-limited signup creates an
 * account + first admin user + a default publishable key in one transaction.
 * Email is globally unique; password policy is min-8.
 */
export const signupRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  name: z.string().trim().min(1),
  account_name: z.string().trim().min(1),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

/** An account (tenant root). */
export const accountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  created_at: z.union([z.date(), z.iso.datetime()]),
});
export type Account = z.infer<typeof accountSchema>;

/** A publishable API key. `key` is NOT a secret (B1-D3) — it ships in clients. */
export const apiKeyEnvironmentSchema = z.enum(['live', 'test']);
export type ApiKeyEnvironment = z.infer<typeof apiKeyEnvironmentSchema>;

export const apiKeySchema = z.object({
  id: z.uuid(),
  key: z.string(),
  label: z.string(),
  environment: apiKeyEnvironmentSchema,
  allowed_origins: z.array(z.string()),
  created_at: z.union([z.date(), z.iso.datetime()]),
  revoked_at: z.union([z.date(), z.iso.datetime()]).nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

/**
 * POST /v1/console/keys body (B3, key management). Create a publishable key with an
 * optional browser origin allow-list (B2-D7). `environment` defaults to `live`.
 */
export const apiKeyCreateSchema = z.object({
  label: z.string().trim().min(1).max(200).default('default'),
  environment: apiKeyEnvironmentSchema.default('live'),
  allowed_origins: z.array(z.string().trim().min(1)).default([]),
});
export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

/** POST /v1/console/auth/signup response. */
export const signupResponseSchema = z.object({
  account: accountSchema,
  user: z.object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    role: z.enum(['admin', 'editor']),
  }),
  publishable_key: z.string(),
});
export type SignupResponse = z.infer<typeof signupResponseSchema>;
