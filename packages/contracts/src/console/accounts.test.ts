import { describe, expect, it } from 'vitest';
import { accountSchema, apiKeySchema, signupRequestSchema } from '../index.js';

describe('signupRequestSchema', () => {
  const valid = {
    email: 'owner@example.com',
    password: 'password8',
    name: 'Owner',
    account_name: 'Acme',
  };
  it('accepts a valid signup', () => {
    expect(signupRequestSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects a password shorter than 8 (B1-D10)', () => {
    expect(signupRequestSchema.safeParse({ ...valid, password: 'short7!' }).success).toBe(false);
  });
  it('rejects a non-email', () => {
    expect(signupRequestSchema.safeParse({ ...valid, email: 'nope' }).success).toBe(false);
  });
  it('rejects a blank account_name', () => {
    expect(signupRequestSchema.safeParse({ ...valid, account_name: '  ' }).success).toBe(false);
  });
});

describe('accountSchema', () => {
  it('accepts a valid account', () => {
    expect(
      accountSchema.safeParse({
        id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
        name: 'Acme',
        created_at: '2026-08-03T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('apiKeySchema', () => {
  it('accepts a live publishable key with null revoked_at', () => {
    expect(
      apiKeySchema.safeParse({
        id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
        key: 'pk_live_abc',
        label: 'default',
        environment: 'live',
        allowed_origins: [],
        created_at: '2026-08-03T00:00:00.000Z',
        revoked_at: null,
      }).success,
    ).toBe(true);
  });
  it('rejects an unknown environment', () => {
    expect(
      apiKeySchema.safeParse({
        id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
        key: 'pk_x_abc',
        label: 'default',
        environment: 'staging',
        allowed_origins: [],
        created_at: '2026-08-03T00:00:00.000Z',
        revoked_at: null,
      }).success,
    ).toBe(false);
  });
});
