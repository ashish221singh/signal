import type { askFrequencySchema } from '@signal/contracts';
import type { z } from 'zod';

type AskFrequency = z.infer<typeof askFrequencySchema>;

const DAY_MS = 86_400_000;

const COOLDOWN_DAYS: Record<AskFrequency, number> = {
  after_7_days: 7,
  after_30_days: 30,
  after_60_days: 60,
};

export function cooldownEndsAt(frequency: AskFrequency, from: Date): Date {
  return new Date(from.getTime() + COOLDOWN_DAYS[frequency] * DAY_MS);
}
