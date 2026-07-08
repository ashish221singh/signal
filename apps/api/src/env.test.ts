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
});
