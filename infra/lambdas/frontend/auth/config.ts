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

/** Validates trusted pool/table configuration and the fixed application-session contract. */
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

export interface AuthRequestBudget {
  readonly signal: AbortSignal;
  remainingMs(): number;
}

/** Reserves response time and bounds the complete request to at most twenty seconds of work. */
export function createAuthRequestBudget(lambdaRemainingMs: number): AuthRequestBudget {
  if (!Number.isFinite(lambdaRemainingMs) || lambdaRemainingMs <= 2_000) throw new BffAuthError('session_unavailable');
  const duration = Math.min(20_000, Math.floor(lambdaRemainingMs - 2_000));
  const deadline = Date.now() + duration;
  return { signal: AbortSignal.timeout(duration), remainingMs: () => Math.max(0, deadline - Date.now()) };
}

/** Clamps each SDK request to the original deadline, retaining a final response reserve. */
export function authRequestOptions(budget?: AuthRequestBudget, maximumMs = 10_000): { abortSignal: AbortSignal } {
  const timeout = Math.min(maximumMs, Math.floor((budget?.remainingMs() ?? 10_500) - 500));
  if (timeout <= 0 || budget?.signal.aborted) throw new BffAuthError('session_unavailable');
  const signal = AbortSignal.timeout(timeout);
  return { abortSignal: budget ? AbortSignal.any([budget.signal, signal]) : signal };
}
