import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });
  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'Tr0ub4dor&3')).toBe(false);
  });
  it('produces distinct hashes for the same input (salted)', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });
  it('verifyPassword returns false on a malformed hash, never throws', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
