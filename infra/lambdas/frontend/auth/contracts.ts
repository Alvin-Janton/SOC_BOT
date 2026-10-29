import { z } from 'zod';
import { BffAuthError } from './errors';

const emailSchema = z.string().trim().toLowerCase().min(1).max(128).email();
const signupPasswordSchema = z.string().min(15).max(256).refine(value => !/\s/u.test(value));
const emailCredentialsSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
const signupSchema = z.strictObject({ email: emailSchema, password: signupPasswordSchema });
const confirmationSchema = z.strictObject({ email: emailSchema,
  code: z.string().min(1).max(2048).refine(value => !/\s/u.test(value)) });
const resendSchema = z.strictObject({ email: emailSchema });

export type EmailCredentials = Readonly<z.output<typeof emailCredentialsSchema>>;
export type AuthRoute = 'login' | 'me' | 'logout' | 'signup' | 'confirm-signup' | 'resend-confirmation';
export type SignupCredentials = Readonly<z.output<typeof signupSchema>>;
export type SignupConfirmation = Readonly<z.output<typeof confirmationSchema>>;
export type ConfirmationResend = Readonly<z.output<typeof resendSchema>>;

/** Normalizes only the case-insensitive email alias; password text is never transformed. */
export function parseEmailCredentials(value: unknown): EmailCredentials {
  const result = emailCredentialsSchema.safeParse(value);
  if (!result.success) throw new BffAuthError('invalid_input');
  return result.data;
}

/** Validates new-account fields without changing login rules or transforming passwords. */
export function parseSignupCredentials(value: unknown): SignupCredentials {
  const result = signupSchema.safeParse(value);
  if (!result.success) {
    if (result.error.issues.every(issue => issue.path.length === 1 && issue.path[0] === 'password')) {
      throw new BffAuthError('invalid_signup_password');
    }
    throw new BffAuthError('invalid_input');
  }
  return result.data;
}

/** Preserves confirmation codes as supplied strings, including any leading zeroes. */
export function parseSignupConfirmation(value: unknown): SignupConfirmation {
  const result = confirmationSchema.safeParse(value);
  if (!result.success) throw new BffAuthError('invalid_input');
  return result.data;
}

/** Accepts only a normalized email alias for confirmation-code resend. */
export function parseConfirmationResend(value: unknown): ConfirmationResend {
  const result = resendSchema.safeParse(value);
  if (!result.success) throw new BffAuthError('invalid_input');
  return result.data;
}
