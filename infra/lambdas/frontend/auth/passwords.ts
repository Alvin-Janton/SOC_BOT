import { ChangePasswordCommand, ConfirmForgotPasswordCommand, ForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { createBffAuth } from './bff';
import { createCognitoAuthenticator, createCognitoClient, createCognitoPasswordMutationClient, PasswordChangeProof } from './cognito';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig } from './config';
import { parseConfirmationResend, parsePasswordChange, parsePasswordReset } from './contracts';
import { AuthStateInitializationConflict, BffAuthError } from './errors';
import { createUserAuthStateStore } from './user-state';

export const PASSWORD_RECOVERY_RESPONSE = Object.freeze({
  message: 'If this account is eligible for password recovery, check your email for a reset code.',
});
export const PASSWORD_UPDATED_RESPONSE = Object.freeze({ message: 'Password updated. Sign in again.' });

export interface PasswordService {
  forgot(value: unknown): Promise<void>;
  reset(value: unknown): Promise<void>;
  change(value: unknown, cookieHeader?: string): Promise<void>;
}

/** Classifies only provider exception names, never diagnostic messages or credential values. */
function errorName(error: unknown): string { return error instanceof Error ? error.name : ''; }

/** Maps safe pre-mutation failures without changing login or registration error behavior. */
function passwordServiceError(error: unknown): BffAuthError {
  if (error instanceof BffAuthError) return error;
  if (['TooManyRequestsException', 'TooManyFailedAttemptsException', 'ThrottlingException',
    'LimitExceededException', 'RequestLimitExceeded', 'RequestLimitExceededException'].includes(errorName(error))) {
    return new BffAuthError('throttled');
  }
  return new BffAuthError('password_service_unavailable');
}

/** Distinguishes definite rejections from password mutations whose remote outcome cannot be established. */
function mutationError(error: unknown, operation: 'reset' | 'change'): BffAuthError {
  const name = errorName(error);
  const safe = passwordServiceError(error);
  if (safe.code === 'throttled') return safe;
  if (['InvalidPasswordException', 'PasswordHistoryPolicyViolationException'].includes(name)) return new BffAuthError('invalid_new_password');
  if (operation === 'reset' && ['CodeMismatchException', 'ExpiredCodeException', 'UserNotFoundException',
    'NotAuthorizedException', 'UserNotConfirmedException'].includes(name)) return new BffAuthError('password_reset_failed');
  if (operation === 'change' && ['NotAuthorizedException', 'PasswordResetRequiredException',
    'UserNotFoundException', 'UserNotConfirmedException'].includes(name)) return new BffAuthError('password_change_failed');
  if (['InvalidParameterException', 'ResourceNotFoundException', 'OperationNotEnabledException', 'ForbiddenException'].includes(name)) {
    return new BffAuthError('password_service_unavailable');
  }
  // This includes transport/timeout and internal/trigger failures after dispatch; no mutation retry or revocation inference.
  return new BffAuthError('password_update_unconfirmed');
}

/** Coordinates recovery/password proof and post-success session revocation without storing provider tokens. */
export function createPasswordService(config: BffAuthConfig, budget: AuthRequestBudget): PasswordService {
  const client = createCognitoClient(config);
  const mutations = createCognitoPasswordMutationClient(config);
  const cognito = createCognitoAuthenticator(config, client, budget);
  const users = createUserAuthStateStore(config, undefined, budget);

  /** Ensures trusted recovery metadata exists without resetting versions or adopting malformed state. */
  async function ensureResetMetadata(sub: string): Promise<void> {
    try {
      if (await users.readForProvisioning(sub)) return;
      try { await users.initialize(sub); }
      catch (error) { if (!(error instanceof AuthStateInitializationConflict)) throw error; }
      if (!await users.readForProvisioning(sub)) throw new BffAuthError('password_reset_failed');
    } catch (error) {
      if (error instanceof BffAuthError && error.code === 'authentication_failed') throw new BffAuthError('password_reset_failed');
      throw passwordServiceError(error);
    }
  }

  /** Reserves six seconds for a two-second read, three-second transaction and response before dispatch. */
  async function mutate(work: (options: { abortSignal: AbortSignal }) => Promise<unknown>, operation: 'reset' | 'change'): Promise<void> {
    if (budget.signal.aborted || budget.remainingMs() < 10_000) throw new BffAuthError('password_service_unavailable');
    const options = authRequestOptions(budget, 4_000);
    try { await work(options); }
    catch (error) { throw mutationError(error, operation); }
  }

  /** Keeps the transient access-token capability scoped to the freshly authenticated mutation only. */
  async function changeWithProof(currentPassword: string, newPassword: string, cookieHeader?: string): Promise<string> {
    const auth = createBffAuth(config, { budget });
    const session = await auth.requireSession(cookieHeader);
    let proof: PasswordChangeProof;

    try {
      const account = await cognito.lookupAccount(session.sub);
      if (account.sub !== session.sub) throw new BffAuthError('password_change_failed');
      proof = await cognito.passwordChangeProof({ username: account.username, password: currentPassword }, session.sub);
    }

    catch (error) {
      const safe = passwordServiceError(error);
      throw safe.statusCode === 401 || safe.statusCode === 403 ? new BffAuthError('password_change_failed') : safe;
    }
    const current = await auth.requireSession(cookieHeader);

    if (current.sub !== session.sub || current.expiresAt !== session.expiresAt
      || proof.tokenExpiresAt <= Math.floor(Date.now() / 1_000)) throw new BffAuthError('authentication_required');

    await mutate(options => mutations.send(new ChangePasswordCommand({ AccessToken: proof.accessToken,
      PreviousPassword: currentPassword, ProposedPassword: newPassword }), options), 'change');
    return session.sub;
  }

  return {
    /** Requests a code with generic eligibility responses and no application-state or cookie mutation. */
    async forgot(value: unknown): Promise<void> {
      const { email } = parseConfirmationResend(value);

      try {
        await client.send(new ForgotPasswordCommand({ ClientId: config.clientId, Username: email }), authRequestOptions(budget));
      }

      catch (error) {
        const name = errorName(error);
        if (name === 'UserNotFoundException') return;

        if (['InvalidParameterException', 'NotAuthorizedException'].includes(name)) {
          if (!await cognito.lookupRecoveryAccount(email)) return;
          throw new BffAuthError('password_service_unavailable');
        }

        throw passwordServiceError(error);
      }
    },

    /** Uses canonical account/code proof, then revokes sessions only after confirmed provider success. */
    async reset(value: unknown): Promise<void> {
      const { email, code, newPassword } = parsePasswordReset(value);
      const account = await cognito.lookupRecoveryAccount(email);
      if (!account) throw new BffAuthError('password_reset_failed');
      await ensureResetMetadata(account.sub);
      await mutate(options => mutations.send(new ConfirmForgotPasswordCommand({ ClientId: config.clientId, Username: account.username,
        ConfirmationCode: code, Password: newPassword }), options), 'reset');
      await users.revokeAfterPasswordChange(account.sub);
    },

    /** Revalidates the original cookie after fresh password/access-token proof, then updates and revokes. */
    async change(value: unknown, cookieHeader?: string): Promise<void> {
      const { currentPassword, newPassword } = parsePasswordChange(value);
      const sub = await changeWithProof(currentPassword, newPassword, cookieHeader);
      await users.revokeAfterPasswordChange(sub);
    },
  };
}
