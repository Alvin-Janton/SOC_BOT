import type { LoginResult } from './bff';
import { CognitoAuthenticator, LoginCredentials } from './cognito';
import { parseEmailCredentials } from './contracts';
import { BffAuthError } from './errors';
import { TrustedAuthenticationContext, UserAuthStateStore } from './user-state';

/** Resolves canonical identity and captures durable enabled state before password verification begins. */
export function createEmailPasswordLogin(cognito: CognitoAuthenticator, users: UserAuthStateStore,
  completeLogin: (credentials: LoginCredentials, context: TrustedAuthenticationContext) => Promise<LoginResult>) {
  return async (value: unknown): Promise<LoginResult> => {
    const credentials = parseEmailCredentials(value);
    const account = await cognito.lookupAccount(credentials.email);
    const state = await users.readForProvisioning(account.sub);
    if (state === undefined) {
      try {
        await users.initialize(account.sub);
      } catch (error) {
        // A conditional initialization loser gets only the strong snapshot read below, never a reset.
        if (!(error instanceof BffAuthError) || error.code !== 'authentication_failed') throw error;
      }
    }
    const snapshot = await users.readForAuthentication(account.sub);
    return completeLogin({ username: account.username, password: credentials.password }, snapshot);
  };
}
