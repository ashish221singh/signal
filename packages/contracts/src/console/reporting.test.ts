import { describe, expect, it } from 'vitest';
import {
  campaignOverviewSchema,
  dashboardSummarySchema,
  eventsOverviewSchema,
  reasonsSchema,
  responseFeedQuerySchema,
  responseFeedSchema,
  trendSchema,
} from '../index.js';

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

const CID = '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e';

describe('reasonsSchema', () => {
  const reasons = {
    campaign_id: CID,
    total_chip_responses: 10,
    chips: [
      { chip: 'Too slow', count: 6, share: 0.6 },
      { chip: 'Confusing', count: 4, share: 0.4 },
    ],
  };

  it('parses a fully-populated reasons breakdown', () => {
    expect(reasonsSchema.safeParse(reasons).success).toBe(true);
  });

  it('accepts an empty chips array with zero total', () => {
    expect(
      reasonsSchema.safeParse({ campaign_id: CID, total_chip_responses: 0, chips: [] }).success,
    ).toBe(true);
  });

  it('rejects a non-integer chip count', () => {
    expect(
      reasonsSchema.safeParse({
        ...reasons,
        chips: [{ chip: 'Too slow', count: 6.5, share: 0.6 }],
      }).success,
    ).toBe(false);
  });
});

describe('responseFeedSchema', () => {
  const item = {
    id: CID,
    rating_value: 4,
    chip_selected: 'Too slow',
    other_text: null,
    other_image_url: null,
    location: { lat: 12.9, lng: 77.6, state: 'KA', country: 'IN' },
    device_os: 'android',
    app_version: '1.2.3',
    shown_at: '2026-07-08T10:00:00Z',
    responded_at: '2026-07-08T10:00:05Z',
  };
  const feed = { items: [item], next_cursor: 'abc' };

  it('parses a fully-populated feed page', () => {
    expect(responseFeedSchema.safeParse(feed).success).toBe(true);
  });

  it('accepts null location / cursor / optional nullable fields', () => {
    expect(
      responseFeedSchema.safeParse({
        items: [{ ...item, chip_selected: null, location: null }],
        next_cursor: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a non-integer rating_value', () => {
    expect(
      responseFeedSchema.safeParse({ items: [{ ...item, rating_value: 4.5 }], next_cursor: null })
        .success,
    ).toBe(false);
  });
});

describe('responseFeedQuerySchema', () => {
  it('coerces query strings and applies the default limit', () => {
    const parsed = responseFeedQuerySchema.safeParse({ min_rating: '2', max_rating: '5' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.min_rating).toBe(2);
      expect(parsed.data.limit).toBe(50);
    }
  });

  it('rejects an out-of-range rating', () => {
    expect(responseFeedQuerySchema.safeParse({ min_rating: '6' }).success).toBe(false);
  });

  it('rejects a limit above the max', () => {
    expect(responseFeedQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });
});

describe('trendSchema', () => {
  const trend = {
    campaign_id: CID,
    points: [
      { date: '2026-07-08', responses: 6, positive_score: 0.5 },
      { date: '2026-07-09', responses: 0, positive_score: null },
    ],
  };

  it('parses a fully-populated trend', () => {
    expect(trendSchema.safeParse(trend).success).toBe(true);
  });

  it('rejects a non-integer responses count', () => {
    expect(
      trendSchema.safeParse({
        campaign_id: CID,
        points: [{ date: '2026-07-08', responses: 6.5, positive_score: 0.5 }],
      }).success,
    ).toBe(false);
  });
});

describe('eventsOverviewSchema', () => {
  it('parses a populated events overview with null-safe ratios', () => {
    const ok = eventsOverviewSchema.safeParse({
      events: [
        {
          event_name: 'checkout_completed',
          triggers: 10,
          responses: 4,
          response_rate: 0.4,
          positive_score: 0.75,
        },
        {
          event_name: 'app_opened',
          triggers: 0,
          responses: 0,
          response_rate: null,
          positive_score: null,
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a non-integer triggers count', () => {
    expect(
      eventsOverviewSchema.safeParse({
        events: [
          {
            event_name: 'x',
            triggers: 1.5,
            responses: 0,
            response_rate: null,
            positive_score: null,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
