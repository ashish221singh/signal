import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

describe('parseEnv', () => {
  it('applies defaults when optional vars are absent', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from string', () => {
    const env = parseEnv({ PORT: '8080' });
    expect(env.PORT).toBe(8080);
  });

  it('throws a readable error on invalid NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging-ish' })).toThrow(/NODE_ENV/);
  });

  it('throws a readable error on non-numeric PORT', () => {
    expect(() => parseEnv({ PORT: 'yes' })).toThrow(/PORT/);
  });

  it('defaults DATABASE_URL to the local dev connection string in development', () => {
    const env = parseEnv({});
    expect(env.DATABASE_URL).toBe('postgresql://signal:signal_local_dev@localhost:5433/signal');
  });

  it('defaults appKeys to the dev app key in development', () => {
    const env = parseEnv({});
    expect(env.appKeys).toEqual(['dev-app-key']);
  });

  it('throws in production when DATABASE_URL and SIGNAL_APP_KEYS are unset', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/SIGNAL_APP_KEYS/);
  });

  it('parses SIGNAL_APP_KEYS as a trimmed comma-separated list', () => {
    const env = parseEnv({ SIGNAL_APP_KEYS: 'k1, k2' });
    expect(env.appKeys).toEqual(['k1', 'k2']);
  });
});
