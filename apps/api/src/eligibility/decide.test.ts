import { describe, expect, it } from 'vitest';
import { type DecisionInput, decide } from './decide.js';

const now = new Date('2026-07-08T10:00:00Z');
const past = new Date('2026-07-08T09:00:00Z');
const future = new Date('2026-07-08T11:00:00Z');

const campaign = { minTenureDays: null as number | null, dailyCap: null as number | null };

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    campaign,
    suppression: undefined,
    repTenureDays: undefined,
    showsInLast24h: 0,
    now,
    ...overrides,
  };
}

describe('decide', () => {
  it('never-asked user is eligible', () => {
    expect(decide(input({}))).toEqual({ eligible: true });
  });
  it('suppressed until a future time → not eligible (reason: suppressed)', () => {
    expect(
      decide(input({ suppression: { nextEligibleAt: future, lastAction: 'dismissed' } })),
    ).toEqual({
      eligible: false,
      reason: 'suppressed',
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
    });
  });
  it('under tenure → not eligible', () => {
    expect(
      decide(input({ campaign: { ...campaign, minTenureDays: 90 }, repTenureDays: 89 })),
    ).toEqual({
      eligible: false,
      reason: 'under_tenure',
    });
  });
  it('tenure boundary: exactly min → eligible', () => {
    expect(
      decide(input({ campaign: { ...campaign, minTenureDays: 90 }, repTenureDays: 90 })),
    ).toEqual({
      eligible: true,
    });
  });
  it('tenure gate + unknown tenure → fails closed (M1-D8)', () => {
    expect(decide(input({ campaign: { ...campaign, minTenureDays: 90 } }))).toEqual({
      eligible: false,
      reason: 'tenure_unknown',
    });
  });
  it('no tenure gate + unknown tenure → eligible', () => {
    expect(decide(input({}))).toEqual({ eligible: true });
  });
  it('daily cap reached → not eligible', () => {
    expect(decide(input({ campaign: { ...campaign, dailyCap: 2 }, showsInLast24h: 2 }))).toEqual({
      eligible: false,
      reason: 'daily_cap',
    });
  });
  it('under daily cap → eligible', () => {
    expect(decide(input({ campaign: { ...campaign, dailyCap: 2 }, showsInLast24h: 1 }))).toEqual({
      eligible: true,
    });
  });
  it('no daily cap → shows count ignored', () => {
    expect(decide(input({ showsInLast24h: 500 }))).toEqual({ eligible: true });
  });
});
