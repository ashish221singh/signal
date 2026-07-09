import { describe, expect, it } from 'vitest';
import { slugify } from './slug.js';

/**
 * Unit tests for the pure `slugify` helper (M2, Task 14). No DB — runs without
 * Docker. Rules: lowercase; every run of non-alphanumeric chars → a single `_`;
 * trim leading/trailing `_`. Digits are preserved.
 */
describe('slugify', () => {
  it('lowercases and single-space → underscore', () => {
    expect(slugify('Order Completion')).toBe('order_completion');
  });

  it('collapses multiple separators / punctuation into one underscore', () => {
    expect(slugify('Order  Completion!!')).toBe('order_completion');
  });

  it('is idempotent on an already-slugged input', () => {
    expect(slugify('order_completion')).toBe('order_completion');
  });

  it('trims leading and trailing whitespace/underscores', () => {
    expect(slugify('  Spaced  ')).toBe('spaced');
  });

  it('trims leading and trailing punctuation', () => {
    expect(slugify('!!!Hello, World!!!')).toBe('hello_world');
  });

  it('preserves digits and mixes them with letters', () => {
    expect(slugify('Checkout Step 2')).toBe('checkout_step_2');
    expect(slugify('v1.2.3 Release')).toBe('v1_2_3_release');
  });

  it('collapses a run of mixed separators (spaces, dashes, dots) into one underscore', () => {
    expect(slugify('a - . _ b')).toBe('a_b');
  });

  it('returns empty string for all-punctuation input', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('')).toBe('');
  });
});
