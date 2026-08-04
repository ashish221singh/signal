import { describe, expect, it } from 'vitest';
import { eligibilityConfigSchema, eligibilityQuerySchema } from './index.js';

describe('eligibilityQuerySchema', () => {
  it('accepts minimal valid query and coerces session_age_days from string', () => {
    const r = eligibilityQuerySchema.safeParse({
      event_name: 'checkout_completed',
      user_id: 'u_1',
      session_age_days: '210',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.session_age_days).toBe(210);
  });
  it('accepts an optional context string', () => {
    const r = eligibilityQuerySchema.safeParse({
      event_name: 'checkout_completed',
      user_id: 'u_1',
      context: 'OrderSummaryScreen',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.context).toBe('OrderSummaryScreen');
  });
  it('session_age_days and context are optional', () => {
    const r = eligibilityQuerySchema.safeParse({
      event_name: 'e',
      user_id: 'u',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.session_age_days).toBeUndefined();
      expect(r.data.context).toBeUndefined();
    }
  });
  it('rejects negative session_age_days and empty ids', () => {
    expect(eligibilityQuerySchema.safeParse({ event_name: '', user_id: 'u' }).success).toBe(false);
    expect(
      eligibilityQuerySchema.safeParse({
        event_name: 'e',
        user_id: 'u',
        session_age_days: '-4',
      }).success,
    ).toBe(false);
  });
});

describe('eligibilityConfigSchema', () => {
  it('accepts a full workflow config with trigger_id', () => {
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
      positive_action: { type: 'store_review' },
      negative_action: { type: 'redirect', url: 'https://support.example.com' },
      skip_enabled: true,
    });
    expect(r.success).toBe(true);
  });
  it('rejects a config missing trigger_id', () => {
    const r = eligibilityConfigSchema.safeParse({ campaign_id: 'x' });
    expect(r.success).toBe(false);
  });
});
