import { z } from 'zod';

export const uploadRequestSchema = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

export const uploadTicketSchema = z.object({
  upload_url: z.url(),
  object_url: z.url(),
  key: z.string(),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;
