import { describe, expect, it } from 'vitest';
import { campaignStatusSchema, ratingBoundsFor } from './index.js';

describe('campaignStatusSchema', () => {
  it('accepts every DB campaign_status value including archived', () => {
    for (const status of ['draft', 'active', 'paused', 'archived']) {
      expect(campaignStatusSchema.safeParse(status).success).toBe(true);
    }
  });
  it('rejects an unknown status', () => {
    expect(campaignStatusSchema.safeParse('live').success).toBe(false);
  });
});

describe('ratingBoundsFor', () => {
  it('star is always 1..5', () => {
    expect(ratingBoundsFor('star', null)).toEqual({ min: 1, max: 5 });
  });
  it('emoji is always 1..3', () => {
    expect(ratingBoundsFor('emoji', null)).toEqual({ min: 1, max: 3 });
  });
  it('effort_scale uses the campaign scale max', () => {
    expect(ratingBoundsFor('effort_scale', 3)).toEqual({ min: 1, max: 3 });
    expect(ratingBoundsFor('effort_scale', 5)).toEqual({ min: 1, max: 5 });
  });
  it('effort_scale defaults to 5 when scale max is absent', () => {
    expect(ratingBoundsFor('effort_scale', null)).toEqual({ min: 1, max: 5 });
  });
});
