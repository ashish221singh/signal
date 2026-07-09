import { describe, expect, it } from 'vitest';
import { loginRequestSchema, sessionUserSchema } from '../index.js';

describe('loginRequestSchema', () => {
  it('accepts a valid email + password', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'admin@example.com', password: 'hunter2' }).success,
    ).toBe(true);
  });
  it('rejects a bad email', () => {
    expect(
      loginRequestSchema.safeParse({ email: 'not-an-email', password: 'hunter2' }).success,
    ).toBe(false);
  });
  it('rejects an empty password', () => {
    expect(loginRequestSchema.safeParse({ email: 'admin@example.com', password: '' }).success).toBe(
      false,
    );
  });
});

describe('sessionUserSchema', () => {
  it('accepts a valid session user', () => {
    const r = sessionUserSchema.safeParse({
      id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
      email: 'editor@example.com',
      name: 'Ed Itor',
      role: 'editor',
    });
    expect(r.success).toBe(true);
  });
  it('accepts the admin role', () => {
    const r = sessionUserSchema.safeParse({
      id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
      email: 'admin@example.com',
      name: 'Ad Min',
      role: 'admin',
    });
    expect(r.success).toBe(true);
  });
  it('rejects a bad uuid and an unknown role', () => {
    expect(
      sessionUserSchema.safeParse({
        id: 'nope',
        email: 'editor@example.com',
        name: 'Ed Itor',
        role: 'editor',
      }).success,
    ).toBe(false);
    expect(
      sessionUserSchema.safeParse({
        id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
        email: 'editor@example.com',
        name: 'Ed Itor',
        role: 'viewer',
      }).success,
    ).toBe(false);
  });
});
