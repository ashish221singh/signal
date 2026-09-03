import { z } from 'zod';

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'must be an ISO-8601 timestamp',
});

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  state: z.string().optional(),
  country: z.string().optional(),
});

export const responseBodySchema = z.object({
  trigger_id: z.uuid(),
  rating_value: z.number().int().min(1).max(5),
  chip_selected: z.string().nullish(),
  other_text: z.string().max(2000).nullish(),
  other_image_url: z.url().nullish(),
  // End-user identity (F5): the client's OWN user name/email, forwarded via
  // Signal.identify()/init traits — human-readable, captured at response time.
  // The stable user id lives on the trigger; these are optional (anonymous ok).
  user_name: z.string().max(200).nullish(),
  user_email: z.string().max(320).nullish(),
  location: locationSchema.nullish(),
  device_os: z.string().min(1),
  app_version: z.string().min(1),
  session_age_days: z.number().int().nonnegative().nullish(),
  shown_at: isoInstant,
  responded_at: isoInstant,
});
export type ResponseBody = z.infer<typeof responseBodySchema>;

export const dismissBodySchema = z.object({
  trigger_id: z.uuid(),
  shown_at: isoInstant,
  dismissed_at: isoInstant,
});
export type DismissBody = z.infer<typeof dismissBodySchema>;
