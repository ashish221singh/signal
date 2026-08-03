import { describe, expect, it } from 'vitest';
import { dismissBodySchema, responseBodySchema } from './index.js';

const base = {
  trigger_id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
  rating_value: 4,
  device_os: 'Android 14',
  app_version: '4.12.0',
  shown_at: '2026-07-07T10:12:00Z',
  responded_at: '2026-07-07T10:12:18Z',
};

describe('responseBodySchema', () => {
  it('accepts a minimal positive response', () => {
    expect(responseBodySchema.safeParse(base).success).toBe(true);
  });
  it('accepts a negative response with chip, text, image, location', () => {
    const r = responseBodySchema.safeParse({
      ...base,
      rating_value: 1,
      chip_selected: 'Sync failed',
      other_text: 'kept timing out',
      other_image_url: 'https://cdn.example.com/x.jpg',
      location: { lat: 30.9, lng: 75.8, state: 'Punjab', country: 'IN' },
      session_age_days: 210,
    });
    expect(r.success).toBe(true);
  });
  it('rejects rating outside 1..5, bad uuid, bad timestamps', () => {
    expect(responseBodySchema.safeParse({ ...base, rating_value: 0 }).success).toBe(false);
    expect(responseBodySchema.safeParse({ ...base, rating_value: 6 }).success).toBe(false);
    expect(responseBodySchema.safeParse({ ...base, trigger_id: 'nope' }).success).toBe(false);
    expect(responseBodySchema.safeParse({ ...base, shown_at: 'yesterday' }).success).toBe(false);
  });
});

describe('dismissBodySchema', () => {
  it('accepts trigger_id + timestamps', () => {
    const r = dismissBodySchema.safeParse({
      trigger_id: base.trigger_id,
      shown_at: base.shown_at,
      dismissed_at: '2026-07-07T10:12:03Z',
    });
    expect(r.success).toBe(true);
  });
});
