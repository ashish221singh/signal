import { describe, expect, it } from 'vitest';
import { cooldownEndsAt } from './cooldown.js';

const now = new Date('2026-07-08T10:00:00Z');
const DAY = 86_400_000;

describe('cooldownEndsAt', () => {
  it('after_7_days = now + 7 days', () => {
    expect(cooldownEndsAt('after_7_days', now).getTime()).toBe(now.getTime() + 7 * DAY);
  });
  it('after_30_days = now + 30 days', () => {
    expect(cooldownEndsAt('after_30_days', now).getTime()).toBe(now.getTime() + 30 * DAY);
  });
  it('after_60_days = now + 60 days', () => {
    expect(cooldownEndsAt('after_60_days', now).getTime()).toBe(now.getTime() + 60 * DAY);
  });
});
