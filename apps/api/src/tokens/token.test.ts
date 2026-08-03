import { describe, expect, it } from 'vitest';
import { CLI_TOKEN_PATTERN, constantTimeHashEqual, generateCliToken, hashToken } from './token.js';

describe('generateCliToken', () => {
  it('produces a cli_<32 base62> token', () => {
    const token = generateCliToken();
    expect(CLI_TOKEN_PATTERN.test(token)).toBe(true);
  });
  it('is unique across draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateCliToken());
    expect(seen.size).toBe(1000);
  });
});

describe('hashToken', () => {
  it('is a deterministic 64-char sha256 hex', () => {
    const t = generateCliToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(h);
  });
  it('differs for different tokens', () => {
    expect(hashToken(generateCliToken())).not.toBe(hashToken(generateCliToken()));
  });
  it('never stores the plaintext (hash is not a substring of the token)', () => {
    const t = generateCliToken();
    expect(hashToken(t).includes(t.slice(4))).toBe(false);
  });
});

describe('constantTimeHashEqual', () => {
  it('true for identical hashes', () => {
    const h = hashToken('cli_x');
    expect(constantTimeHashEqual(h, h)).toBe(true);
  });
  it('false for different hashes', () => {
    expect(constantTimeHashEqual(hashToken('a'), hashToken('b'))).toBe(false);
  });
  it('false (no throw) when lengths differ', () => {
    expect(constantTimeHashEqual('abc', 'abcd')).toBe(false);
  });
});
