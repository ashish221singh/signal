import { describe, expect, it } from 'vitest';
import { generateDeviceCode, generateUserCode, hashDeviceCode } from './deviceCode.js';

describe('generateDeviceCode', () => {
  it('is a dev_ prefixed high-entropy code, unique across draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = generateDeviceCode();
      expect(c).toMatch(/^dev_[A-Za-z0-9]{40}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(500);
  });
});

describe('hashDeviceCode', () => {
  it('is deterministic sha256 hex', () => {
    expect(hashDeviceCode('dev_x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceCode('dev_x')).toBe(hashDeviceCode('dev_x'));
  });
});

describe('generateUserCode', () => {
  it('is XXXX-XXXX from an unambiguous alphabet (no I,O,0,1)', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateUserCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(c).not.toMatch(/[IO01]/);
    }
  });
});
