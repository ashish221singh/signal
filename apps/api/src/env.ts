import { z } from 'zod';

const DEV_DATABASE_URL = 'postgresql://signal:signal_local_dev@localhost:5433/signal';
const DEV_APP_KEYS = 'dev-app-key';
const DEV_SESSION_SECRET = 'dev-session-secret-not-for-prod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url().optional(),
  SIGNAL_APP_KEYS: z.string().optional(),
  SESSION_SECRET: z.string().min(16).optional(),
});

export type Env = Omit<
  z.infer<typeof envSchema>,
  'DATABASE_URL' | 'SIGNAL_APP_KEYS' | 'SESSION_SECRET'
> & {
  DATABASE_URL: string;
  appKeys: string[];
  SESSION_SECRET: string;
};

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  const { DATABASE_URL, SIGNAL_APP_KEYS, SESSION_SECRET, ...rest } = result.data;
  const isProduction = rest.NODE_ENV === 'production';

  const databaseUrl = DATABASE_URL ?? (isProduction ? undefined : DEV_DATABASE_URL);
  const appKeysRaw = SIGNAL_APP_KEYS ?? (isProduction ? undefined : DEV_APP_KEYS);
  const sessionSecret = SESSION_SECRET ?? (isProduction ? undefined : DEV_SESSION_SECRET);

  if (databaseUrl === undefined || appKeysRaw === undefined || sessionSecret === undefined) {
    const missing = [
      ...(databaseUrl === undefined ? ['DATABASE_URL'] : []),
      ...(appKeysRaw === undefined ? ['SIGNAL_APP_KEYS'] : []),
      ...(sessionSecret === undefined ? ['SESSION_SECRET'] : []),
    ];
    throw new Error(`Missing required environment variables in production: ${missing.join(', ')}`);
  }

  const appKeys = appKeysRaw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  return { ...rest, DATABASE_URL: databaseUrl, appKeys, SESSION_SECRET: sessionSecret };
}
