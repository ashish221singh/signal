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

  it('defaults SESSION_SECRET to the dev constant in development', () => {
    const env = parseEnv({});
    expect(env.SESSION_SECRET).toBe('dev-session-secret-not-for-prod');
  });

  it('exposes an explicitly provided SESSION_SECRET', () => {
    const env = parseEnv({ SESSION_SECRET: 'a-sufficiently-long-secret' });
    expect(env.SESSION_SECRET).toBe('a-sufficiently-long-secret');
  });

  it('rejects an explicitly provided SESSION_SECRET shorter than 16 chars', () => {
    expect(() => parseEnv({ SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('throws in production when SESSION_SECRET is unset', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        SIGNAL_APP_KEYS: 'k1',
      }),
    ).toThrow(/SESSION_SECRET/);
  });
});
