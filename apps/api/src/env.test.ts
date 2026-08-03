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

  it('throws in production when DATABASE_URL is unset', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
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
      SESSION_SECRET: 'a-sufficiently-long-secret',
    };
    expect(() => parseEnv(base)).toThrow(/S3_ACCESS_KEY/);
    expect(() => parseEnv(base)).toThrow(/S3_SECRET_KEY/);
  });

  it('defaults PUBLIC_BASE_URL to localhost in development', () => {
    expect(parseEnv({}).PUBLIC_BASE_URL).toBe('http://localhost:3000');
  });

  it('exposes an explicitly provided PUBLIC_BASE_URL', () => {
    expect(parseEnv({ PUBLIC_BASE_URL: 'https://app.example.com' }).PUBLIC_BASE_URL).toBe(
      'https://app.example.com',
    );
  });

  it('defaults ALLOW_PASSWORD_CLI_LOGIN ON in dev/test, OFF in production (B3-D4, GR-10)', () => {
    expect(parseEnv({}).ALLOW_PASSWORD_CLI_LOGIN).toBe(true);
    expect(parseEnv({ NODE_ENV: 'test' }).ALLOW_PASSWORD_CLI_LOGIN).toBe(true);
    const prod = parseEnv(prodBase());
    expect(prod.ALLOW_PASSWORD_CLI_LOGIN).toBe(false);
  });

  it('honours an explicit ALLOW_PASSWORD_CLI_LOGIN override', () => {
    expect(parseEnv({ ALLOW_PASSWORD_CLI_LOGIN: 'false' }).ALLOW_PASSWORD_CLI_LOGIN).toBe(false);
    const prodOn = parseEnv({ ...prodBase(), ALLOW_PASSWORD_CLI_LOGIN: 'true' });
    expect(prodOn.ALLOW_PASSWORD_CLI_LOGIN).toBe(true);
  });

  it('defaults CONSOLE_ORIGINS to localhost dev origins and parses the comma list (B4-D2)', () => {
    expect(parseEnv({}).CONSOLE_ORIGINS).toEqual([
      'http://localhost:5173',
      'http://localhost:3000',
    ]);
    expect(
      parseEnv({ CONSOLE_ORIGINS: 'https://a.example, https://b.example ,,' }).CONSOLE_ORIGINS,
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it('throws in production when PUBLIC_BASE_URL is unset (B4-D4)', () => {
    const { PUBLIC_BASE_URL, ...rest } = prodBase();
    void PUBLIC_BASE_URL;
    expect(() => parseEnv(rest)).toThrow(/PUBLIC_BASE_URL/);
  });

  it('throws in production when CONSOLE_ORIGINS is unset (B4-D4)', () => {
    const { CONSOLE_ORIGINS, ...rest } = prodBase();
    void CONSOLE_ORIGINS;
    expect(() => parseEnv(rest)).toThrow(/CONSOLE_ORIGINS/);
  });

  it('does not throw in production when the full required set is provided (B4-D4)', () => {
    const env = parseEnv(prodBase());
    expect(env.S3_ACCESS_KEY).toBe('AKIA');
    expect(env.S3_SECRET_KEY).toBe('secret');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_BUCKET).toBe('signal-feedback-images');
    expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
    expect(env.S3_PUBLIC_URL).toBe('http://localhost:9000/signal-feedback-images');
    expect(env.PUBLIC_BASE_URL).toBe('https://app.example.com');
    expect(env.CONSOLE_ORIGINS).toEqual(['https://app.example.com']);
  });
});

/**
 * The full production-required env set (B4-D4): DATABASE_URL, SESSION_SECRET,
 * S3_ACCESS_KEY, S3_SECRET_KEY, PUBLIC_BASE_URL, CONSOLE_ORIGINS. Tests remove
 * one field at a time to prove each is enforced.
 */
function prodBase() {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    SESSION_SECRET: 'a-sufficiently-long-secret',
    S3_ACCESS_KEY: 'AKIA',
    S3_SECRET_KEY: 'secret',
    PUBLIC_BASE_URL: 'https://app.example.com',
    CONSOLE_ORIGINS: 'https://app.example.com',
  } as const;
}
