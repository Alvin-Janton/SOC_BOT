import { z } from 'zod';
import { BffAuthError } from './errors';

const emailCredentialsSchema = z.strictObject({
  email: z.string().trim().toLowerCase().min(1).max(128).email(),
  password: z.string().min(1).max(256),
});

export type EmailCredentials = Readonly<z.output<typeof emailCredentialsSchema>>;
export type AuthRoute = 'login' | 'me' | 'logout';

/** Normalizes only the case-insensitive email alias; password text is never transformed. */
export function parseEmailCredentials(value: unknown): EmailCredentials {
  const result = emailCredentialsSchema.safeParse(value);
  if (!result.success) throw new BffAuthError('invalid_input');
  return result.data;
}
