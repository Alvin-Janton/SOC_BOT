import { BffAuthError } from '../auth/errors';
import { authSubSchema } from '../auth/user-state';
import { header } from './browser-request';
import { record } from './origin-guard';

/** Reads an optional context hint; duplicate/conflicting headers and non-exact subjects fail closed. */
export function expectedUser(raw: unknown): string | undefined {
  const event = record(raw);
  if (!event) throw new BffAuthError('invalid_input');
  const value = header(event, 'X-Soc-Bot-Expected-User');
  if (value !== undefined && (!authSubSchema.safeParse(value).success || /[^A-Za-z0-9_-]/.test(value))) {
    throw new BffAuthError('invalid_input');
  }
  return value;
}

/** Compares only against an independently authenticated principal, never granting identity from the hint. */
export function requireExpectedUser(expected: string | undefined, principal: string): void {
  if (expected !== undefined && expected !== principal) throw new BffAuthError('account_context_changed');
}
