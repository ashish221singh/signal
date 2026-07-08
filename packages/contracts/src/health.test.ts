import { describe, expect, it } from 'vitest';
import { healthResponseSchema, SIGNAL_API_VERSION } from './index.js';

describe('health contract', () => {
  it('accepts a valid health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      version: SIGNAL_API_VERSION,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = healthResponseSchema.safeParse({
      status: 'sideways',
      version: SIGNAL_API_VERSION,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing version', () => {
    const result = healthResponseSchema.safeParse({ status: 'ok' });
    expect(result.success).toBe(false);
  });
});
