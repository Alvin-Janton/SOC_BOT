import { z } from 'zod';
import { BffAuthError } from './errors';

const configurationSchema = z.strictObject({
  userPoolId: z.string().min(1).max(55).regex(/^[a-z]{2}(?:-[a-z0-9]+)+-\d_[A-Za-z0-9]+$/),
  clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_+]+$/),
  sessionTableName: z.string().min(3).max(255).regex(/^[A-Za-z0-9_.-]+$/)
    .refine(value => !/^SOC-BOT-(DEV|DEMO)-CHAT-HISTORY$/.test(value)),
  sessionLifetimeSeconds: z.number().int().min(60).max(86_400).default(3_600),
  sameSite: z.enum(['Lax', 'Strict']).default('Lax'),
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
