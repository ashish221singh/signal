import type { askFrequencySchema } from '@signal/contracts';
import type { z } from 'zod';

type AskFrequency = z.infer<typeof askFrequencySchema>;

const HOUR_MS = 3_600_000;

export function cooldownEndsAt(
  frequency: AskFrequency,
  from: Date,
  noCooldownDebounceSeconds: number,
): Date {
  switch (frequency) {
    case 'once_per_day':
      return new Date(from.getTime() + 24 * HOUR_MS);
    case 'once_per_week':
      return new Date(from.getTime() + 168 * HOUR_MS);
    case 'no_cooldown':
      return new Date(from.getTime() + noCooldownDebounceSeconds * 1000);
  }
}
