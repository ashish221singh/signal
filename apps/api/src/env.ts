import { z } from 'zod';

const DEV_DATABASE_URL = 'postgresql://signal:signal_local_dev@localhost:5433/signal';
const DEV_SESSION_SECRET = 'dev-session-secret-not-for-prod';
const DEV_S3_ENDPOINT = 'http://localhost:9000';
const DEV_S3_REGION = 'us-east-1';
const DEV_S3_BUCKET = 'signal-feedback-images';
const DEV_S3_ACCESS_KEY = 'signal';
const DEV_S3_SECRET_KEY = 'signal_local_dev';
const DEV_S3_PUBLIC_URL = 'http://localhost:9000/signal-feedback-images';

const DEV_PUBLIC_BASE_URL = 'http://localhost:3000';
// Dashboard dev origins allowed to call `/v1/console/*` with credentials (B4-D2).
// The Vite dev server (5173) and a same-origin 3000 during local dev.
const DEV_CONSOLE_ORIGINS = 'http://localhost:5173,http://localhost:3000';

/** Split a comma-separated origin list into a trimmed, non-empty array. */
function parseOriginList(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * `ALLOW_PASSWORD_CLI_LOGIN` (B3-D4, GR-10) accepts a boolean-ish string. When
 * absent it defaults ON in dev/test and OFF in production (computed below), so
 * device-flow is the only prod path.
 */
const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // SDK ingest rate limit per (publishableKey + user_id) per minute (B2-D7).
  SDK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  // Public base URL for the device-flow `verification_uri` (B3-D3). Defaults to
  // localhost in dev; must be set to the real host before first deploy (GR-8).
  PUBLIC_BASE_URL: z.url().optional(),
  // Dashboard origins allowed to make credentialed cross-origin calls to
  // `/v1/console/*` (B4-D2). A comma-separated list. Defaults to localhost dev
  // origins; REQUIRED in production so the deployed dashboard can reach the API.
  CONSOLE_ORIGINS: z.string().optional(),
  // Interim password→CLI-token login gate (B3-D4, GR-10).
  ALLOW_PASSWORD_CLI_LOGIN: booleanish.optional(),
  // Google OAuth (F3): "Log in with Google". Both id+secret must be present for the
  // Google routes to activate; when absent, /auth/google returns 503 and the login
  // page hides the button (dev/test run fine without them). The callback URL
  // defaults to `${PUBLIC_BASE_URL}/v1/console/auth/google/callback` and can be
  // overridden (e.g. behind a proxy) via GOOGLE_CALLBACK_URL.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.url().optional(),
  DATABASE_URL: z.url().optional(),
  SESSION_SECRET: z.string().min(16).optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.url().optional(),
});

export type Env = Omit<
  z.infer<typeof envSchema>,
  | 'DATABASE_URL'
  | 'SESSION_SECRET'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY'
  | 'S3_SECRET_KEY'
  | 'S3_PUBLIC_URL'
  | 'PUBLIC_BASE_URL'
  | 'CONSOLE_ORIGINS'
  | 'ALLOW_PASSWORD_CLI_LOGIN'
  | 'GOOGLE_CALLBACK_URL'
> & {
  DATABASE_URL: string;
  SESSION_SECRET: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_PUBLIC_URL: string;
  PUBLIC_BASE_URL: string;
  CONSOLE_ORIGINS: string[];
  ALLOW_PASSWORD_CLI_LOGIN: boolean;
  // Present only when both id+secret are configured (Google login enabled).
  GOOGLE_CALLBACK_URL: string;
};

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  const {
    DATABASE_URL,
    SESSION_SECRET,
    S3_ENDPOINT,
    S3_REGION,
    S3_BUCKET,
    S3_ACCESS_KEY,
    S3_SECRET_KEY,
    S3_PUBLIC_URL,
    PUBLIC_BASE_URL,
    CONSOLE_ORIGINS,
    ALLOW_PASSWORD_CLI_LOGIN,
    GOOGLE_CALLBACK_URL,
    ...rest
  } = result.data;
  const isProduction = rest.NODE_ENV === 'production';

  // Interim password login gate (B3-D4, GR-10): explicit value wins; otherwise
  // ON in dev/test, OFF in production so device-flow is the only prod path.
  const allowPasswordCliLogin = ALLOW_PASSWORD_CLI_LOGIN ?? !isProduction;

  const databaseUrl = DATABASE_URL ?? (isProduction ? undefined : DEV_DATABASE_URL);
  const sessionSecret = SESSION_SECRET ?? (isProduction ? undefined : DEV_SESSION_SECRET);
  // B4-D4: `PUBLIC_BASE_URL` (device-flow verification URI / hosted links) and
  // `CONSOLE_ORIGINS` (dashboard CORS) are REQUIRED in production; they default
  // to localhost only in dev/test.
  const publicBaseUrl = PUBLIC_BASE_URL ?? (isProduction ? undefined : DEV_PUBLIC_BASE_URL);
  const consoleOriginsRaw = CONSOLE_ORIGINS ?? (isProduction ? undefined : DEV_CONSOLE_ORIGINS);

  // Endpoint/region/bucket/publicUrl are safe to default even in production;
  // only the S3 secrets (access/secret keys) must be provided in production.
  const s3Endpoint = S3_ENDPOINT ?? DEV_S3_ENDPOINT;
  const s3Region = S3_REGION ?? DEV_S3_REGION;
  const s3Bucket = S3_BUCKET ?? DEV_S3_BUCKET;
  const s3PublicUrl = S3_PUBLIC_URL ?? DEV_S3_PUBLIC_URL;
  const s3AccessKey = S3_ACCESS_KEY ?? (isProduction ? undefined : DEV_S3_ACCESS_KEY);
  const s3SecretKey = S3_SECRET_KEY ?? (isProduction ? undefined : DEV_S3_SECRET_KEY);

  if (
    databaseUrl === undefined ||
    sessionSecret === undefined ||
    s3AccessKey === undefined ||
    s3SecretKey === undefined ||
    publicBaseUrl === undefined ||
    consoleOriginsRaw === undefined
  ) {
    const missing = [
      ...(databaseUrl === undefined ? ['DATABASE_URL'] : []),
      ...(sessionSecret === undefined ? ['SESSION_SECRET'] : []),
      ...(s3AccessKey === undefined ? ['S3_ACCESS_KEY'] : []),
      ...(s3SecretKey === undefined ? ['S3_SECRET_KEY'] : []),
      ...(publicBaseUrl === undefined ? ['PUBLIC_BASE_URL'] : []),
      ...(consoleOriginsRaw === undefined ? ['CONSOLE_ORIGINS'] : []),
    ];
    throw new Error(`Missing required environment variables in production: ${missing.join(', ')}`);
  }

  // Google callback URL defaults to the public base + the callback route path, so
  // in most deployments only GOOGLE_CLIENT_ID/SECRET need to be set.
  const googleCallbackUrl =
    GOOGLE_CALLBACK_URL ?? `${publicBaseUrl}/v1/console/auth/google/callback`;

  return {
    ...rest,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: sessionSecret,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: s3Region,
    S3_BUCKET: s3Bucket,
    S3_ACCESS_KEY: s3AccessKey,
    S3_SECRET_KEY: s3SecretKey,
    S3_PUBLIC_URL: s3PublicUrl,
    PUBLIC_BASE_URL: publicBaseUrl,
    CONSOLE_ORIGINS: parseOriginList(consoleOriginsRaw),
    ALLOW_PASSWORD_CLI_LOGIN: allowPasswordCliLogin,
    GOOGLE_CALLBACK_URL: googleCallbackUrl,
  };
}
