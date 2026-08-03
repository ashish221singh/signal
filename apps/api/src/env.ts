import { z } from 'zod';

const DEV_DATABASE_URL = 'postgresql://signal:signal_local_dev@localhost:5433/signal';
const DEV_SESSION_SECRET = 'dev-session-secret-not-for-prod';
const DEV_S3_ENDPOINT = 'http://localhost:9000';
const DEV_S3_REGION = 'us-east-1';
const DEV_S3_BUCKET = 'signal-feedback-images';
const DEV_S3_ACCESS_KEY = 'signal';
const DEV_S3_SECRET_KEY = 'signal_local_dev';
const DEV_S3_PUBLIC_URL = 'http://localhost:9000/signal-feedback-images';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // SDK ingest rate limit per (publishableKey + user_id) per minute (B2-D7).
  SDK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
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
> & {
  DATABASE_URL: string;
  SESSION_SECRET: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_PUBLIC_URL: string;
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
    ...rest
  } = result.data;
  const isProduction = rest.NODE_ENV === 'production';

  const databaseUrl = DATABASE_URL ?? (isProduction ? undefined : DEV_DATABASE_URL);
  const sessionSecret = SESSION_SECRET ?? (isProduction ? undefined : DEV_SESSION_SECRET);

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
    s3SecretKey === undefined
  ) {
    const missing = [
      ...(databaseUrl === undefined ? ['DATABASE_URL'] : []),
      ...(sessionSecret === undefined ? ['SESSION_SECRET'] : []),
      ...(s3AccessKey === undefined ? ['S3_ACCESS_KEY'] : []),
      ...(s3SecretKey === undefined ? ['S3_SECRET_KEY'] : []),
    ];
    throw new Error(`Missing required environment variables in production: ${missing.join(', ')}`);
  }

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
  };
}
