import { describe, expect, it } from 'vitest';
import { campaignOverviewSchema } from '../index.js';

describe('campaignOverviewSchema', () => {
  const overview = {
    campaign_id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
    triggers: 5,
    responses: 3,
    response_rate: 0.6,
    positive_score: 0.6666666666666666,
  };

  it('parses a fully-populated overview', () => {
    expect(campaignOverviewSchema.safeParse(overview).success).toBe(true);
  });

  it('accepts null response_rate and positive_score (zero triggers/responses)', () => {
    expect(
      campaignOverviewSchema.safeParse({
        ...overview,
        triggers: 0,
        responses: 0,
        response_rate: null,
        positive_score: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a non-integer triggers count', () => {
    expect(campaignOverviewSchema.safeParse({ ...overview, triggers: 5.5 }).success).toBe(false);
  });

  it('rejects a non-uuid campaign_id', () => {
    expect(campaignOverviewSchema.safeParse({ ...overview, campaign_id: 'nope' }).success).toBe(
      false,
    );
  });
});
