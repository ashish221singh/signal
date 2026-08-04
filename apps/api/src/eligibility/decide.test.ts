import { describe, expect, it } from 'vitest';
import { type DecisionInput, decide } from './decide.js';

const now = new Date('2026-07-08T10:00:00Z');
const past = new Date('2026-07-08T09:00:00Z');
const future = new Date('2026-07-08T11:00:00Z');

const workflow = { minSessionAgeDays: null as number | null, samplingRate: 1 };

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    workflow,
    suppression: undefined,
    sessionAgeDays: undefined,
    now,
    ...overrides,
  };
}

describe('decide', () => {
  it('never-asked user is eligible', () => {
    expect(decide(input({}))).toEqual({ eligible: true });
  });
  it('suppressed until a future time → not eligible (reason: suppressed), record:false', () => {
    expect(
      decide(input({ suppression: { nextEligibleAt: future, lastAction: 'dismissed' } })),
    ).toEqual({
      eligible: false,
      reason: 'suppressed',
      record: false,
    });
  });
  it('cooldown expired → eligible again', () => {
    expect(
      decide(input({ suppression: { nextEligibleAt: past, lastAction: 'dismissed' } })),
    ).toEqual({
      eligible: true,
    });
  });
  it('cooldown boundary: eligible exactly AT next_eligible_at', () => {
    expect(
      decide(input({ suppression: { nextEligibleAt: now, lastAction: 'dismissed' } })),
    ).toEqual({
      eligible: true,
    });
  });
  it('submitted (nextEligibleAt null) → never again', () => {
    expect(
      decide(input({ suppression: { nextEligibleAt: null, lastAction: 'submitted' } })),
    ).toEqual({
      eligible: false,
      reason: 'never_reask',
      record: false,
    });
  });

  describe('session-age gate', () => {
    it('under session age → not eligible', () => {
      expect(
        decide(input({ workflow: { ...workflow, minSessionAgeDays: 90 }, sessionAgeDays: 89 })),
      ).toEqual({
        eligible: false,
        reason: 'under_session_age',
        record: false,
      });
    });
    it('session-age boundary: exactly min → eligible', () => {
      expect(
        decide(input({ workflow: { ...workflow, minSessionAgeDays: 90 }, sessionAgeDays: 90 })),
      ).toEqual({
        eligible: true,
      });
    });
    it('session-age gate + unknown session age → fails closed', () => {
      expect(decide(input({ workflow: { ...workflow, minSessionAgeDays: 90 } }))).toEqual({
        eligible: false,
        reason: 'session_age_unknown',
        record: false,
      });
    });
    it('no session-age gate + unknown session age → eligible', () => {
      expect(decide(input({}))).toEqual({ eligible: true });
    });
  });

  describe('sampling gate (B2-D4)', () => {
    it('sampling_rate=1 always fires regardless of rng', () => {
      expect(
        decide(input({ workflow: { ...workflow, samplingRate: 1 }, rng: () => 0.999 })),
      ).toEqual({ eligible: true });
    });
    it('sampled: rng below the rate → eligible', () => {
      expect(
        decide(input({ workflow: { ...workflow, samplingRate: 0.5 }, rng: () => 0.4 })),
      ).toEqual({ eligible: true });
    });
    it('not-sampled: rng at/above the rate → not_sampled, record:false', () => {
      expect(
        decide(input({ workflow: { ...workflow, samplingRate: 0.5 }, rng: () => 0.5 })),
      ).toEqual({ eligible: false, reason: 'not_sampled', record: false });
      expect(
        decide(input({ workflow: { ...workflow, samplingRate: 0.5 }, rng: () => 0.9 })),
      ).toEqual({ eligible: false, reason: 'not_sampled', record: false });
    });
    it('sampling_rate=0 never fires', () => {
      expect(decide(input({ workflow: { ...workflow, samplingRate: 0 }, rng: () => 0 }))).toEqual({
        eligible: false,
        reason: 'not_sampled',
        record: false,
      });
    });
    it('sampling runs AFTER cooldown — a suppressed user is suppressed, not not_sampled', () => {
      expect(
        decide(
          input({
            workflow: { ...workflow, samplingRate: 0 },
            suppression: { nextEligibleAt: future, lastAction: 'dismissed' },
            rng: () => 0,
          }),
        ),
      ).toEqual({ eligible: false, reason: 'suppressed', record: false });
    });
  });
});
