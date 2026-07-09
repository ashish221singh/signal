import { z } from 'zod';

export const metricTypeSchema = z.enum(['CSAT', 'CES']);
export const ratingTypeSchema = z.enum(['star', 'emoji', 'effort_scale']);
export const askFrequencySchema = z.enum(['after_7_days', 'after_30_days', 'after_60_days']);
export const onPositiveActionSchema = z.enum(['none', 'play_store_review']);
export const campaignStatusSchema = z.enum(['draft', 'active', 'paused']);
export const triggerMechanismSchema = z.enum(['action', 'dwell']);

export type RatingType = z.infer<typeof ratingTypeSchema>;

export function ratingBoundsFor(
  ratingType: RatingType,
  ratingScaleMax: number | null,
): { min: number; max: number } {
  switch (ratingType) {
    case 'star':
      return { min: 1, max: 5 };
    case 'emoji':
      return { min: 1, max: 3 };
    case 'effort_scale':
      return { min: 1, max: ratingScaleMax === 3 ? 3 : 5 };
  }
}

export const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
