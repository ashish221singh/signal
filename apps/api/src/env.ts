import { z } from 'zod';

const DEV_DATABASE_URL = 'postgresql://signal:signal_local_dev@localhost:5433/signal';
const DEV_APP_KEYS = 'dev-app-key';
const DEV_SESSION_SECRET = 'dev-session-secret-not-for-prod';
const DEV_S3_ENDPOINT = 'http://localhost:9000';
const DEV_S3_REGION = 'us-east-1';
const DEV_S3_BUCKET = 'signal-feedback-images';
const DEV_S3_ACCESS_KEY = 'signal';
const DEV_S3_SECRET_KEY = 'signal_local_dev';
const DEV_S3_PUBLIC_URL = 'http://localhost:9000/signal-feedback-images';
const DEV_BEATROUTE_TOKEN_URL = 'http://localhost:4599/oauth/token';
const DEV_BEATROUTE_CLIENTS_API_URL = 'http://localhost:4599/v1/clients';
const DEV_BEATROUTE_CLIENT_ID = 'signal-backend';
const DEV_BEATROUTE_CLIENT_SECRET = 'dev-beatroute-secret';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url().optional(),
  SIGNAL_APP_KEYS: z.string().optional(),
  SESSION_SECRET: z.string().min(16).optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.url().optional(),
  BEATROUTE_TOKEN_URL: z.url().optional(),
  BEATROUTE_CLIENTS_API_URL: z.url().optional(),
  BEATROUTE_CLIENT_ID: z.string().optional(),
  BEATROUTE_CLIENT_SECRET: z.string().optional(),
  BEATROUTE_OAUTH_SCOPE: z.string().default('clients:read'),
});

export type Env = Omit<
  z.infer<typeof envSchema>,
  | 'DATABASE_URL'
  | 'SIGNAL_APP_KEYS'
  | 'SESSION_SECRET'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY'
  | 'S3_SECRET_KEY'
  | 'S3_PUBLIC_URL'
  | 'BEATROUTE_TOKEN_URL'
  | 'BEATROUTE_CLIENTS_API_URL'
  | 'BEATROUTE_CLIENT_ID'
  | 'BEATROUTE_CLIENT_SECRET'
> & {
  DATABASE_URL: string;
  appKeys: string[];
  SESSION_SECRET: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_PUBLIC_URL: string;
  BEATROUTE_TOKEN_URL: string;
  BEATROUTE_CLIENTS_API_URL: string;
  BEATROUTE_CLIENT_ID: string;
  BEATROUTE_CLIENT_SECRET: string;
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
    SIGNAL_APP_KEYS,
    SESSION_SECRET,
    S3_ENDPOINT,
    S3_REGION,
    S3_BUCKET,
    S3_ACCESS_KEY,
    S3_SECRET_KEY,
    S3_PUBLIC_URL,
    BEATROUTE_TOKEN_URL,
    BEATROUTE_CLIENTS_API_URL,
    BEATROUTE_CLIENT_ID,
    BEATROUTE_CLIENT_SECRET,
    ...rest
  } = result.data;
  const isProduction = rest.NODE_ENV === 'production';

  const databaseUrl = DATABASE_URL ?? (isProduction ? undefined : DEV_DATABASE_URL);
  const appKeysRaw = SIGNAL_APP_KEYS ?? (isProduction ? undefined : DEV_APP_KEYS);
  const sessionSecret = SESSION_SECRET ?? (isProduction ? undefined : DEV_SESSION_SECRET);

  // Endpoint/region/bucket/publicUrl are safe to default even in production;
  // only the S3 secrets (access/secret keys) must be provided in production.
  const s3Endpoint = S3_ENDPOINT ?? DEV_S3_ENDPOINT;
  const s3Region = S3_REGION ?? DEV_S3_REGION;
  const s3Bucket = S3_BUCKET ?? DEV_S3_BUCKET;
  const s3PublicUrl = S3_PUBLIC_URL ?? DEV_S3_PUBLIC_URL;
  const s3AccessKey = S3_ACCESS_KEY ?? (isProduction ? undefined : DEV_S3_ACCESS_KEY);
  const s3SecretKey = S3_SECRET_KEY ?? (isProduction ? undefined : DEV_S3_SECRET_KEY);

  // BeatRoute OAuth (client-sync job). Dev/test use a local mock; in production
  // the four vars below are required (secret originates from a secrets manager).
  const beatrouteTokenUrl =
    BEATROUTE_TOKEN_URL ?? (isProduction ? undefined : DEV_BEATROUTE_TOKEN_URL);
  const beatrouteClientsApiUrl =
    BEATROUTE_CLIENTS_API_URL ?? (isProduction ? undefined : DEV_BEATROUTE_CLIENTS_API_URL);
  const beatrouteClientId =
    BEATROUTE_CLIENT_ID ?? (isProduction ? undefined : DEV_BEATROUTE_CLIENT_ID);
  const beatrouteClientSecret =
    BEATROUTE_CLIENT_SECRET ?? (isProduction ? undefined : DEV_BEATROUTE_CLIENT_SECRET);

  if (
    databaseUrl === undefined ||
    appKeysRaw === undefined ||
    sessionSecret === undefined ||
    s3AccessKey === undefined ||
    s3SecretKey === undefined ||
    beatrouteTokenUrl === undefined ||
    beatrouteClientsApiUrl === undefined ||
    beatrouteClientId === undefined ||
    beatrouteClientSecret === undefined
  ) {
    const missing = [
      ...(databaseUrl === undefined ? ['DATABASE_URL'] : []),
      ...(appKeysRaw === undefined ? ['SIGNAL_APP_KEYS'] : []),
      ...(sessionSecret === undefined ? ['SESSION_SECRET'] : []),
      ...(s3AccessKey === undefined ? ['S3_ACCESS_KEY'] : []),
      ...(s3SecretKey === undefined ? ['S3_SECRET_KEY'] : []),
      ...(beatrouteTokenUrl === undefined ? ['BEATROUTE_TOKEN_URL'] : []),
      ...(beatrouteClientsApiUrl === undefined ? ['BEATROUTE_CLIENTS_API_URL'] : []),
      ...(beatrouteClientId === undefined ? ['BEATROUTE_CLIENT_ID'] : []),
      ...(beatrouteClientSecret === undefined ? ['BEATROUTE_CLIENT_SECRET'] : []),
    ];
    throw new Error(`Missing required environment variables in production: ${missing.join(', ')}`);
  }

  const appKeys = appKeysRaw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  return {
    ...rest,
    DATABASE_URL: databaseUrl,
    appKeys,
    SESSION_SECRET: sessionSecret,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: s3Region,
    S3_BUCKET: s3Bucket,
    S3_ACCESS_KEY: s3AccessKey,
    S3_SECRET_KEY: s3SecretKey,
    S3_PUBLIC_URL: s3PublicUrl,
    BEATROUTE_TOKEN_URL: beatrouteTokenUrl,
    BEATROUTE_CLIENTS_API_URL: beatrouteClientsApiUrl,
    BEATROUTE_CLIENT_ID: beatrouteClientId,
    BEATROUTE_CLIENT_SECRET: beatrouteClientSecret,
  };
}
