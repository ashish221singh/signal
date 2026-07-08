import { describe, expect, it } from 'vitest';
import { eligibilityConfigSchema, eligibilityQuerySchema } from './index.js';

describe('eligibilityQuerySchema', () => {
  it('accepts minimal valid query and coerces tenure from string', () => {
    const r = eligibilityQuerySchema.safeParse({
      screen_id: 'order_completion',
      user_id: 'u_1',
      client_id: 'cl_A',
      rep_tenure_days: '210',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rep_tenure_days).toBe(210);
  });
  it('tenure is optional', () => {
    const r = eligibilityQuerySchema.safeParse({
      screen_id: 's',
      user_id: 'u',
      client_id: 'c',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rep_tenure_days).toBeUndefined();
  });
  it('rejects negative tenure and empty ids', () => {
    expect(
      eligibilityQuerySchema.safeParse({ screen_id: '', user_id: 'u', client_id: 'c' }).success,
    ).toBe(false);
    expect(
      eligibilityQuerySchema.safeParse({
        screen_id: 's',
        user_id: 'u',
        client_id: 'c',
        rep_tenure_days: '-4',
      }).success,
    ).toBe(false);
  });
});

describe('eligibilityConfigSchema', () => {
  it('accepts a full campaign config with trigger_id', () => {
    const r = eligibilityConfigSchema.safeParse({
      trigger_id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
      campaign_id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2f',
      metric_type: 'CSAT',
      header: 'How satisfied were you with placing this order?',
      rating_type: 'star',
      rating_scale_max: 5,
      positive_threshold: 4,
      chips_on_negative: ['Slow to load', 'Sync failed'],
      other_requires_text: true,
      other_allows_image: true,
      on_positive_action: 'play_store_review',
      skip_enabled: true,
    });
    expect(r.success).toBe(true);
  });
  it('rejects a config missing trigger_id', () => {
    const r = eligibilityConfigSchema.safeParse({ campaign_id: 'x' });
    expect(r.success).toBe(false);
  });
});
