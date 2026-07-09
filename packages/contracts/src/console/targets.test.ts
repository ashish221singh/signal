import { describe, expect, it } from 'vitest';
import { targetSchema } from '../index.js';

const validTarget = {
  id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
  name: 'Home Screen',
  screen_id: 'home',
  trigger_mechanism: 'action',
  integration_status: 'confirmed_live',
};

describe('targetSchema', () => {
  it('accepts a valid target', () => {
    expect(targetSchema.safeParse(validTarget).success).toBe(true);
  });
  it('rejects an unknown integration_status', () => {
    expect(targetSchema.safeParse({ ...validTarget, integration_status: 'live' }).success).toBe(
      false,
    );
  });
  it('rejects an unknown trigger_mechanism', () => {
    expect(targetSchema.safeParse({ ...validTarget, trigger_mechanism: 'scroll' }).success).toBe(
      false,
    );
  });
  it('rejects a missing field', () => {
    const { screen_id: _omit, ...withoutScreenId } = validTarget;
    expect(targetSchema.safeParse(withoutScreenId).success).toBe(false);
  });
  it('rejects a non-uuid id', () => {
    expect(targetSchema.safeParse({ ...validTarget, id: 'nope' }).success).toBe(false);
  });
});
