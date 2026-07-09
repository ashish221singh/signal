import { describe, expect, it } from 'vitest';
import { clientSchema } from '../index.js';

const validClient = { id: 'client-1', name: 'Acme Corp', status: 'active' };

describe('clientSchema', () => {
  it('accepts a valid client', () => {
    expect(clientSchema.safeParse(validClient).success).toBe(true);
  });
  it('accepts the inactive status', () => {
    expect(clientSchema.safeParse({ ...validClient, status: 'inactive' }).success).toBe(true);
  });
  it('rejects an unknown status', () => {
    expect(clientSchema.safeParse({ ...validClient, status: 'archived' }).success).toBe(false);
  });
  it('rejects a missing name', () => {
    const { name: _omit, ...withoutName } = validClient;
    expect(clientSchema.safeParse(withoutName).success).toBe(false);
  });
});
