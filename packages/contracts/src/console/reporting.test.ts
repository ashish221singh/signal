import { describe, expect, it } from 'vitest';
import { campaignOverviewSchema, dashboardSummarySchema } from '../index.js';

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

describe('dashboardSummarySchema', () => {
  const cid = '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e';
  const summary = {
    kpis: { active_campaigns: 2, total_triggers_30d: 40, avg_positive_score: 0.72 },
    attention: [{ campaign_id: cid, header: 'How was it?', reason: 'low_response_rate' }],
    campaigns: [
      {
        campaign_id: cid,
        header: 'How was it?',
        status: 'active',
        integration_status: 'confirmed_live',
        triggers_30d: 20,
        responses_30d: 6,
        response_rate: 0.3,
        positive_score: 0.5,
      },
    ],
  };

  it('parses a fully-populated dashboard summary', () => {
    expect(dashboardSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('accepts null avg_positive_score / rates / integration_status', () => {
    expect(
      dashboardSummarySchema.safeParse({
        kpis: { active_campaigns: 0, total_triggers_30d: 0, avg_positive_score: null },
        attention: [],
        campaigns: [
          {
            campaign_id: cid,
            header: null,
            status: 'paused',
            integration_status: null,
            triggers_30d: 0,
            responses_30d: 0,
            response_rate: null,
            positive_score: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown attention reason', () => {
    expect(
      dashboardSummarySchema.safeParse({
        ...summary,
        attention: [{ campaign_id: cid, header: null, reason: 'nope' }],
      }).success,
    ).toBe(false);
  });
});
