import { z } from 'zod';
import { BffAuthError } from './errors';

export const AUTH_SESSION_LIFETIME_SECONDS = 43_200;

const configurationSchema = z.strictObject({
  userPoolId: z.string().min(1).max(55).regex(/^[a-z]{2}(?:-[a-z0-9]+)+-\d_[A-Za-z0-9]+$/),
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_+]+$/),
  sessionTableName: z.enum(['SOC-BOT-DEV-AUTH-SESSIONS', 'SOC-BOT-DEMO-AUTH-SESSIONS']),
  sessionLifetimeSeconds: z.literal(AUTH_SESSION_LIFETIME_SECONDS).default(AUTH_SESSION_LIFETIME_SECONDS),
  sameSite: z.literal('Lax').default('Lax'),
});

export type BffAuthConfig = Readonly<z.output<typeof configurationSchema>>;

/** Validates explicit source-only configuration without reading deployment environment variables. */
export function parseBffAuthConfig(value: unknown): BffAuthConfig {
  const result = configurationSchema.safeParse(value);
  if (!result.success) throw new BffAuthError('invalid_configuration');
  return Object.freeze(result.data);
}

/** Reads a bounded Unix clock value for expiry and cookie calculations. */
export function currentAuthTime(nowSeconds: () => number): number {
  const value = nowSeconds();
  if (!Number.isSafeInteger(value) || value <= 0 || value > 253_402_300_799) {
    throw new BffAuthError('session_unavailable');
  }
  return value;
}
