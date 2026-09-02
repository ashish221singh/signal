import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/config.js';
import type { WorkflowConfig } from '../src/types.js';

function base(over: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    trigger_id: '11111111-1111-1111-1111-111111111111',
    campaign_id: '22222222-2222-2222-2222-222222222222',
    metric_type: 'CSAT',
    header: 'How was it?',
    rating_type: 'emoji',
    rating_scale_max: 3,
    positive_threshold: 3,
    chips_on_negative: [],
    other_requires_text: false,
    other_allows_image: false,
    positive_action: { type: 'none' },
    negative_action: { type: 'none' },
    skip_enabled: false,
    ...over,
  } as WorkflowConfig;
}

describe('normalizeConfig — fail closed', () => {
  it('accepts a valid config', () => {
    const r = normalizeConfig(base());
    expect(r.ok).toBe(true);
  });

  it('normalizes chips: trims, drops empties, de-dupes, caps at 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => `chip ${i}`);
    const r = normalizeConfig(
      base({ chips_on_negative: ['  Slow  ', 'Slow', '', '   ', 'Confusing', ...many] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.chips.slice(0, 3)).toEqual(['Slow', 'Confusing', 'chip 0']);
    expect(r.config.chips).toHaveLength(8);
    expect(r.config.chips).not.toContain('');
  });

  it('treats a missing/invalid chips field as no chips', () => {
    const r = normalizeConfig(base({ chips_on_negative: undefined as unknown as string[] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.chips).toEqual([]);
  });

  it('rejects missing header/question', () => {
    const r = normalizeConfig(base({ header: '' }));
    expect(r.ok).toBe(false);
  });

  it('rejects missing trigger_id', () => {
    const r = normalizeConfig(base({ trigger_id: '' }));
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid action', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
    const r = normalizeConfig(base({ positive_action: { type: 'bogus' } as any }));
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
    expect(normalizeConfig(null as any).ok).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed
    expect(normalizeConfig(42 as any).ok).toBe(false);
  });
});

describe('normalizeConfig — normalisation', () => {
  it('clamps an out-of-range threshold into 1..3', () => {
    const hi = normalizeConfig(base({ positive_threshold: 9 }));
    if (!hi.ok) throw new Error('expected ok');
    expect(hi.config.positive_threshold).toBe(3);
    const lo = normalizeConfig(base({ positive_threshold: -2 }));
    if (!lo.ok) throw new Error('expected ok');
    expect(lo.config.positive_threshold).toBe(1);
  });

  it('maps an unknown rating type to the emoji fallback (does not crash)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: forward-compat unknown type
    const r = normalizeConfig(base({ rating_type: 'galaxy' as any }));
    if (!r.ok) throw new Error('expected ok');
    expect(r.config.ratingType).toBe('unknown');
    expect(r.config.rating_min).toBe(1);
    expect(r.config.rating_max).toBe(3);
  });

  it('accepts a newer config_version, ignoring unknown fields (F1-D10)', () => {
    const r = normalizeConfig(
      // biome-ignore lint/suspicious/noExplicitAny: forward-compat extra field
      base({ config_version: 99, some_future_field: 'x' } as any),
    );
    expect(r.ok).toBe(true);
  });
});
