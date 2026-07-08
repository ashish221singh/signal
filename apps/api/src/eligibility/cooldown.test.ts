import { describe, expect, it } from 'vitest';
import { cooldownEndsAt } from './cooldown.js';

const now = new Date('2026-07-08T10:00:00Z');
const HOUR = 3_600_000;

describe('cooldownEndsAt', () => {
  it('once_per_day = now + 24h (rolling, not calendar)', () => {
    expect(cooldownEndsAt('once_per_day', now, 60).getTime()).toBe(now.getTime() + 24 * HOUR);
  });
  it('once_per_week = now + 168h', () => {
    expect(cooldownEndsAt('once_per_week', now, 60).getTime()).toBe(now.getTime() + 168 * HOUR);
  });
  it('no_cooldown = now + debounce seconds (M1-D6)', () => {
    expect(cooldownEndsAt('no_cooldown', now, 60).getTime()).toBe(now.getTime() + 60_000);
    expect(cooldownEndsAt('no_cooldown', now, 2).getTime()).toBe(now.getTime() + 2_000);
  });
});
