import { describe, expect, it } from 'vitest';
import { questionsFor, SETUP_FIELDS, setupGuideText } from './index.js';

describe('SETUP_FIELDS', () => {
  it('covers the six publish-required fields', () => {
    const required = SETUP_FIELDS.filter((f) => f.requiredToPublish).map((f) => f.key);
    expect(new Set(required)).toEqual(
      new Set([
        'event_name',
        'metric_type',
        'rating_type',
        'rating_scale_max',
        'header_text',
        'positive_threshold',
      ]),
    );
  });

  it('offers the branched actions and media as optional fields', () => {
    const keys = SETUP_FIELDS.map((f) => f.key);
    for (const k of ['positive_action', 'negative_action', 'other_allows_image', 'ask_frequency']) {
      expect(keys).toContain(k);
    }
  });

  it('rating_type exposes star/emoji/effort_scale options', () => {
    const rt = SETUP_FIELDS.find((f) => f.key === 'rating_type');
    expect(rt?.options?.map((o) => o.value)).toEqual(['star', 'emoji', 'effort_scale']);
  });
});

describe('questionsFor', () => {
  it('maps missing keys to questions in canonical order', () => {
    const qs = questionsFor(['positive_threshold', 'rating_type', 'header_text']);
    expect(qs.map((q) => q.field)).toEqual(['rating_type', 'header_text', 'positive_threshold']);
    expect(qs[0]?.question).toMatch(/rate/i);
    expect(qs[0]?.options?.map((o) => o.value)).toContain('emoji');
  });

  it('falls back to a generic question for an unknown key', () => {
    const qs = questionsFor(['weird_field']);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ field: 'weird_field' });
    expect(qs[0]?.question).toContain('weird_field');
  });

  it('returns nothing for no missing fields', () => {
    expect(questionsFor([])).toEqual([]);
  });
});

describe('setupGuideText', () => {
  it('renders an interview script naming the fields and the never-reask behaviour', () => {
    const text = setupGuideText();
    expect(text).toContain('rating_type');
    expect(text).toContain('positive_threshold');
    expect(text).toContain('store_review');
    expect(text).toMatch(/never asked again/i);
    expect(text).toMatch(/required/);
  });
});
