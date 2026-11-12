import { z } from 'zod';

/** One unchanged chat grammar for HTTP admission and canonical retry construction, without runtime clients. */
export const chatRequestSchema = z.strictObject({
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  turnId: z.uuid(),
  message: z.string().min(1).max(8_192).refine(value => /\S/.test(value)),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
