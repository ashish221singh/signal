import { describe, expect, it } from 'vitest';
import { generateKey, PUBLISHABLE_KEY_PATTERN } from './key.js';

describe('generateKey', () => {
  it('produces a well-formed live key', () => {
    const key = generateKey('live');
    expect(key).toMatch(/^pk_live_[A-Za-z0-9]{24}$/);
    expect(PUBLISHABLE_KEY_PATTERN.test(key)).toBe(true);
  });

  it('produces a well-formed test key', () => {
    const key = generateKey('test');
    expect(key).toMatch(/^pk_test_[A-Za-z0-9]{24}$/);
  });

  it('is overwhelmingly unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateKey('live'));
    expect(seen.size).toBe(1000);
  });
});
