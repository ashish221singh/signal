import { z } from 'zod';

export const SIGNAL_API_VERSION = '0.1.0';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Deep readiness probe (B4-D3): `/ready` reports on the critical dependencies a
 * container platform gates traffic on. `db` is required (a down DB → overall
 * `not_ready` / 503); `s3` is best-effort (a head-bucket failure is surfaced but
 * does NOT fail readiness, since the ingest hot path does not touch S3).
 */
export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    db: z.enum(['ok', 'down']),
    s3: z.enum(['ok', 'down', 'skipped']),
  }),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
