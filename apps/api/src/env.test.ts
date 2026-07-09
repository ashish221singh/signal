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

  it('defaults S3 config to local MinIO values in development', () => {
    const env = parseEnv({});
    expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_BUCKET).toBe('signal-feedback-images');
    expect(env.S3_ACCESS_KEY).toBe('signal');
    expect(env.S3_SECRET_KEY).toBe('signal_local_dev');
    expect(env.S3_PUBLIC_URL).toBe('http://localhost:9000/signal-feedback-images');
  });

  it('exposes explicitly provided S3 config', () => {
    const env = parseEnv({
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'eu-west-1',
      S3_BUCKET: 'prod-images',
      S3_ACCESS_KEY: 'AKIA',
      S3_SECRET_KEY: 'secret',
      S3_PUBLIC_URL: 'https://cdn.example.com/prod-images',
    });
    expect(env.S3_ENDPOINT).toBe('https://s3.example.com');
    expect(env.S3_REGION).toBe('eu-west-1');
    expect(env.S3_BUCKET).toBe('prod-images');
    expect(env.S3_ACCESS_KEY).toBe('AKIA');
    expect(env.S3_SECRET_KEY).toBe('secret');
    expect(env.S3_PUBLIC_URL).toBe('https://cdn.example.com/prod-images');
  });

  it('throws in production when S3_ACCESS_KEY and S3_SECRET_KEY are unset', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SIGNAL_APP_KEYS: 'k1',
      SESSION_SECRET: 'a-sufficiently-long-secret',
    };
    expect(() => parseEnv(base)).toThrow(/S3_ACCESS_KEY/);
    expect(() => parseEnv(base)).toThrow(/S3_SECRET_KEY/);
  });

  it('does not throw in production when S3 secrets are provided', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SIGNAL_APP_KEYS: 'k1',
      SESSION_SECRET: 'a-sufficiently-long-secret',
      S3_ACCESS_KEY: 'AKIA',
      S3_SECRET_KEY: 'secret',
    });
    expect(env.S3_ACCESS_KEY).toBe('AKIA');
    expect(env.S3_SECRET_KEY).toBe('secret');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_BUCKET).toBe('signal-feedback-images');
    expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
    expect(env.S3_PUBLIC_URL).toBe('http://localhost:9000/signal-feedback-images');
  });
});
