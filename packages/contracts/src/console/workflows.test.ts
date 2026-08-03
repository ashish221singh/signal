import { describe, expect, it } from 'vitest';
import {
  workflowDraftCreateSchema,
  workflowListItemSchema,
  workflowSchema,
  workflowUpdateSchema,
} from '../index.js';

describe('workflowDraftCreateSchema', () => {
  it('accepts an empty object (draft can be created empty)', () => {
    expect(workflowDraftCreateSchema.safeParse({}).success).toBe(true);
  });
});

describe('workflowUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(
      workflowUpdateSchema.safeParse({ header_text: 'How was it?', positive_threshold: 4 }).success,
    ).toBe(true);
  });
  it('accepts an empty object (all fields optional)', () => {
    expect(workflowUpdateSchema.safeParse({}).success).toBe(true);
  });
  it('accepts event_name and sampling_rate', () => {
    expect(
      workflowUpdateSchema.safeParse({ event_name: 'checkout_completed', sampling_rate: 0.5 })
        .success,
    ).toBe(true);
  });
  it('rejects an empty event_name', () => {
    expect(workflowUpdateSchema.safeParse({ event_name: '' }).success).toBe(false);
  });
  it('rejects a sampling_rate above 1 or below 0', () => {
    expect(workflowUpdateSchema.safeParse({ sampling_rate: 1.5 }).success).toBe(false);
    expect(workflowUpdateSchema.safeParse({ sampling_rate: -0.1 }).success).toBe(false);
  });
  it('accepts a nullable min_session_age_days set to null', () => {
    expect(workflowUpdateSchema.safeParse({ min_session_age_days: null }).success).toBe(true);
  });
  it('rejects a negative min_session_age_days', () => {
    expect(workflowUpdateSchema.safeParse({ min_session_age_days: -1 }).success).toBe(false);
  });
  it('rejects an unknown ask_frequency', () => {
    expect(workflowUpdateSchema.safeParse({ ask_frequency: 'once_per_week' }).success).toBe(false);
  });
  it('rejects an empty header_text', () => {
    expect(workflowUpdateSchema.safeParse({ header_text: '' }).success).toBe(false);
  });
  it('rejects a non-integer positive_threshold', () => {
    expect(workflowUpdateSchema.safeParse({ positive_threshold: 4.5 }).success).toBe(false);
  });
  it('rejects an unknown metric_type', () => {
    expect(workflowUpdateSchema.safeParse({ metric_type: 'NPS' }).success).toBe(false);
  });
  it('does not allow status in the update body', () => {
    const parsed = workflowUpdateSchema.parse({ status: 'active', header_text: 'Hi' });
    expect('status' in parsed).toBe(false);
  });
});

const fullRow = {
  id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
  event_name: 'checkout_completed',
  sampling_rate: 1,
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
  min_session_age_days: 7,
  status: 'active',
  created_by: 'admin@signal.dev',
  created_at: '2026-07-09T10:00:00.000Z',
  updated_at: '2026-07-09T10:00:00.000Z',
};

describe('workflowSchema', () => {
  it('parses a full active row', () => {
    expect(workflowSchema.safeParse(fullRow).success).toBe(true);
  });
  it('parses a draft row with null content and archived status', () => {
    const draftRow = {
      ...fullRow,
      event_name: null,
      metric_type: null,
      rating_type: null,
      rating_scale_max: null,
      header_text: null,
      positive_threshold: null,
      min_session_age_days: null,
      status: 'archived',
    };
    expect(workflowSchema.safeParse(draftRow).success).toBe(true);
  });
  it('accepts a Date for timestamps', () => {
    expect(
      workflowSchema.safeParse({ ...fullRow, created_at: new Date(), updated_at: new Date() })
        .success,
    ).toBe(true);
  });
  it('rejects an unknown status', () => {
    expect(workflowSchema.safeParse({ ...fullRow, status: 'live' }).success).toBe(false);
  });
});

describe('workflowListItemSchema', () => {
  const listItem = {
    id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
    event_name: 'checkout_completed',
    header_text: 'How was your experience?',
    status: 'active',
    updated_at: '2026-07-09T10:00:00.000Z',
  };
  it('parses a list projection', () => {
    expect(workflowListItemSchema.safeParse(listItem).success).toBe(true);
  });
  it('accepts a null header_text and null event_name', () => {
    expect(
      workflowListItemSchema.safeParse({ ...listItem, header_text: null, event_name: null })
        .success,
    ).toBe(true);
  });
});
