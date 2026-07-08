import { z } from 'zod';

const DEV_DATABASE_URL = 'postgresql://signal:signal_local_dev@localhost:5433/signal';
const DEV_APP_KEYS = 'dev-app-key';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url().optional(),
  SIGNAL_APP_KEYS: z.string().optional(),
  SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(60),
});

export type Env = Omit<z.infer<typeof envSchema>, 'DATABASE_URL' | 'SIGNAL_APP_KEYS'> & {
  DATABASE_URL: string;
  appKeys: string[];
};

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  const { DATABASE_URL, SIGNAL_APP_KEYS, ...rest } = result.data;
  const isProduction = rest.NODE_ENV === 'production';

  const databaseUrl = DATABASE_URL ?? (isProduction ? undefined : DEV_DATABASE_URL);
  const appKeysRaw = SIGNAL_APP_KEYS ?? (isProduction ? undefined : DEV_APP_KEYS);

  if (databaseUrl === undefined || appKeysRaw === undefined) {
    const missing = [
      ...(databaseUrl === undefined ? ['DATABASE_URL'] : []),
      ...(appKeysRaw === undefined ? ['SIGNAL_APP_KEYS'] : []),
    ];
    throw new Error(`Missing required environment variables in production: ${missing.join(', ')}`);
  }

  const appKeys = appKeysRaw
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  return { ...rest, DATABASE_URL: databaseUrl, appKeys };
}
