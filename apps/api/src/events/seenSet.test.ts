import { describe, expect, it } from 'vitest';
import { SeenEventSet } from './seenSet.js';

describe('SeenEventSet', () => {
  it('returns true on first sighting, false thereafter (no per-call work)', () => {
    const set = new SeenEventSet();
    expect(set.markSeen('a', 'checkout')).toBe(true);
    expect(set.markSeen('a', 'checkout')).toBe(false);
    expect(set.markSeen('a', 'checkout')).toBe(false);
  });

  it('scopes by account (same event, different account both fire)', () => {
    const set = new SeenEventSet();
    expect(set.markSeen('a', 'e')).toBe(true);
    expect(set.markSeen('b', 'e')).toBe(true);
    expect(set.markSeen('a', 'e')).toBe(false);
  });

  it('evicts the oldest entry past the LRU bound', () => {
    const set = new SeenEventSet(2);
    expect(set.markSeen('x', 'a')).toBe(true);
    expect(set.markSeen('x', 'b')).toBe(true);
    // touch 'a' so 'b' becomes the LRU victim
    expect(set.markSeen('x', 'a')).toBe(false);
    expect(set.markSeen('x', 'c')).toBe(true); // evicts 'b'
    expect(set.size).toBe(2);
    // 'b' was evicted → it re-fires
    expect(set.markSeen('x', 'b')).toBe(true);
  });
});
