import { z } from 'zod';

export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['admin', 'editor']),
  // How the user authenticates (F3). Optional for backward compatibility; `/me`
  // returns it so the dashboard can show the right account provider.
  provider: z.enum(['google', 'password']).optional(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;
