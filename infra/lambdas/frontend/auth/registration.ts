import { AdminGetUserCommand, ConfirmSignUpCommand, ResendConfirmationCodeCommand, SignUpCommand,
  UserStatusType } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoAuthClient, createCognitoClient } from './cognito';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig } from './config';
import { parseConfirmationResend, parseSignupConfirmation, parseSignupCredentials } from './contracts';
import { BffAuthError } from './errors';

export const REGISTRATION_ACCEPTED_RESPONSE = Object.freeze({
  message: 'If account confirmation is needed, check your email for a confirmation code. You can request another code if needed.',
});
export const SIGNUP_CONFIRMED_RESPONSE = Object.freeze({ message: 'Account confirmed. Sign in to continue.' });

export interface CognitoRegistration {
  signup(value: unknown): Promise<void>;
  confirm(value: unknown): Promise<void>;
  resend(value: unknown): Promise<void>;
}

/** Reads only the provider's exception category, never its message or diagnostic payload. */
function errorName(error: unknown): string { return error instanceof Error ? error.name : ''; }

/** Applies registration-only errors without changing existing login/session error behavior. */
function registrationError(error: unknown): BffAuthError {
  if (error instanceof BffAuthError) return error;
  if (['TooManyRequestsException', 'TooManyFailedAttemptsException', 'ThrottlingException', 'LimitExceededException',
    'RequestLimitExceeded', 'RequestLimitExceededException'].includes(errorName(error))) {
    return new BffAuthError('registration_throttled');
  }
  // Delivery/transport failures can follow account creation; never claim that no account was created.
  return new BffAuthError('registration_unavailable');
}

/** Owns public Cognito registration calls; never creates auth metadata, sessions or cookies. */
export function createCognitoRegistration(config: BffAuthConfig, suppliedClient?: CognitoAuthClient,
  budget?: AuthRequestBudget): CognitoRegistration {
  const client = suppliedClient ?? createCognitoClient(config);

  /** Uses one bounded lookup to distinguish an ineligible resend from an operational failure. */
  async function resendIsIneligible(email: string): Promise<boolean> {
    try {
      const account = await client.send(new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: email }),
        authRequestOptions(budget));

      if (typeof account.Enabled !== 'boolean' || !account.UserStatus
        || !Object.values(UserStatusType).includes(account.UserStatus)) throw new BffAuthError('registration_unavailable');

      return !account.Enabled || account.UserStatus !== UserStatusType.UNCONFIRMED;
    } 
    
    catch (error) {
      if (errorName(error) === 'UserNotFoundException') return true;
      throw registrationError(error);
    }
  }

  return {
    /** Requests an unconfirmed local account, treating duplicate signup as generic acceptance only. */
    async signup(value: unknown): Promise<void> {
      const { email, password } = parseSignupCredentials(value);
      try {
        await client.send(new SignUpCommand({ ClientId: config.clientId, Username: email, Password: password,
          UserAttributes: [{ Name: 'email', Value: email }] }), authRequestOptions(budget));
      } 
      
      catch (error) {
        if (errorName(error) === 'UsernameExistsException') return;
        if (errorName(error) === 'InvalidPasswordException') throw new BffAuthError('invalid_signup_password');
        throw registrationError(error);
      }
    },

    /** Confirms only the supplied code, forbidding alias migration and discarding provider sessions. */
    async confirm(value: unknown): Promise<void> {
      const { email, code } = parseSignupConfirmation(value);
      try {
        await client.send(new ConfirmSignUpCommand({ ClientId: config.clientId, Username: email,
          ConfirmationCode: code, ForceAliasCreation: false }), authRequestOptions(budget));
      } catch (error) {
        if (['CodeMismatchException', 'ExpiredCodeException', 'UserNotFoundException',
          'AliasExistsException', 'NotAuthorizedException'].includes(errorName(error))) {
          throw new BffAuthError('confirmation_failed');
        }
        throw registrationError(error);
      }
    },

    /** Requests another confirmation code without exposing delivery details or account eligibility. */
    async resend(value: unknown): Promise<void> {
      const { email } = parseConfirmationResend(value);
      try {
        await client.send(new ResendConfirmationCodeCommand({ ClientId: config.clientId, Username: email }),
          authRequestOptions(budget));
      } catch (error) {
        const name = errorName(error);
        if (name === 'UserNotFoundException') return;
        if (['InvalidParameterException', 'NotAuthorizedException'].includes(name)) {
          if (await resendIsIneligible(email)) return;
          throw new BffAuthError('registration_unavailable');
        }
        throw registrationError(error);
      }
    },
  };
}
