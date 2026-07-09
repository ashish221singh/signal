import { describe, expect, it } from 'vitest';
import {
  campaignDraftCreateSchema,
  campaignListItemSchema,
  campaignSchema,
  campaignUpdateSchema,
} from '../index.js';

describe('campaignDraftCreateSchema', () => {
  it('accepts an empty object (draft can be created empty)', () => {
    expect(campaignDraftCreateSchema.safeParse({}).success).toBe(true);
  });
  it('accepts { client_ids }', () => {
    expect(campaignDraftCreateSchema.safeParse({ client_ids: ['cl_A'] }).success).toBe(true);
  });
  it('rejects a non-array client_ids', () => {
    expect(campaignDraftCreateSchema.safeParse({ client_ids: 'cl_A' }).success).toBe(false);
  });
});

describe('campaignUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(
      campaignUpdateSchema.safeParse({ header_text: 'How was it?', positive_threshold: 4 }).success,
    ).toBe(true);
  });
  it('accepts an empty object (all fields optional)', () => {
    expect(campaignUpdateSchema.safeParse({}).success).toBe(true);
  });
  it('accepts a nullable min_tenure_days set to null', () => {
    expect(campaignUpdateSchema.safeParse({ min_tenure_days: null }).success).toBe(true);
  });
  it('rejects an unknown ask_frequency', () => {
    expect(campaignUpdateSchema.safeParse({ ask_frequency: 'once_per_week' }).success).toBe(false);
  });
  it('rejects an empty header_text', () => {
    expect(campaignUpdateSchema.safeParse({ header_text: '' }).success).toBe(false);
  });
  it('rejects a non-integer positive_threshold', () => {
    expect(campaignUpdateSchema.safeParse({ positive_threshold: 4.5 }).success).toBe(false);
  });
  it('rejects a non-positive positive_threshold', () => {
    expect(campaignUpdateSchema.safeParse({ positive_threshold: 0 }).success).toBe(false);
  });
  it('rejects an empty-string client id (dead targeting data)', () => {
    expect(campaignUpdateSchema.safeParse({ client_ids: ['cl_A', ''] }).success).toBe(false);
  });
  it('rejects an unknown metric_type', () => {
    expect(campaignUpdateSchema.safeParse({ metric_type: 'NPS' }).success).toBe(false);
  });
  it('rejects a non-uuid target_id', () => {
    expect(campaignUpdateSchema.safeParse({ target_id: 'nope' }).success).toBe(false);
  });
  it('does not allow status in the update body', () => {
    const parsed = campaignUpdateSchema.parse({ status: 'active', header_text: 'Hi' });
    expect('status' in parsed).toBe(false);
  });
});

const fullRow = {
  id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
  target_id: '4a1f7f3f-7f3f-4f3f-9f3f-7f3f7f3f7f3f',
  client_ids: ['cl_A', 'cl_B'],
  metric_type: 'CSAT',
  rating_type: 'star',
  rating_scale_max: 5,
  header_text: 'How was your experience?',
  positive_threshold: 4,
  chips_on_negative: ['Slow', 'Confusing'],
  other_requires_text: true,
  other_allows_image: false,
  on_positive_action: 'play_store_review',
  ask_frequency: 'after_30_days',
  min_tenure_days: 7,
  status: 'active',
  created_by: 'admin@beatroute.io',
  created_at: '2026-07-09T10:00:00.000Z',
  updated_at: '2026-07-09T10:00:00.000Z',
};

describe('campaignSchema', () => {
  it('parses a full active row', () => {
    expect(campaignSchema.safeParse(fullRow).success).toBe(true);
  });
  it('parses a draft row with null content and archived status', () => {
    const draftRow = {
      ...fullRow,
      target_id: null,
      metric_type: null,
      rating_type: null,
      rating_scale_max: null,
      header_text: null,
      positive_threshold: null,
      min_tenure_days: null,
      status: 'archived',
    };
    expect(campaignSchema.safeParse(draftRow).success).toBe(true);
  });
  it('accepts a Date for timestamps', () => {
    expect(
      campaignSchema.safeParse({ ...fullRow, created_at: new Date(), updated_at: new Date() })
        .success,
    ).toBe(true);
  });
  it('rejects an unknown status', () => {
    expect(campaignSchema.safeParse({ ...fullRow, status: 'live' }).success).toBe(false);
  });
});

describe('campaignListItemSchema', () => {
  const listItem = {
    id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
    header_text: 'How was your experience?',
    status: 'active',
    screen_id: 'home',
    client_count: 2,
    updated_at: '2026-07-09T10:00:00.000Z',
  };
  it('parses a list projection', () => {
    expect(campaignListItemSchema.safeParse(listItem).success).toBe(true);
  });
  it('accepts a null header_text and null screen_id', () => {
    expect(
      campaignListItemSchema.safeParse({ ...listItem, header_text: null, screen_id: null }).success,
    ).toBe(true);
  });
  it('rejects a non-integer client_count', () => {
    expect(campaignListItemSchema.safeParse({ ...listItem, client_count: 2.5 }).success).toBe(
      false,
    );
  });
});
