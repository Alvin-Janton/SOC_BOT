import { AdminGetUserCommand, CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoJwtInvalidClientIdError, CognitoJwtInvalidTokenUseError, JwtExpiredError,
  JwtInvalidAudienceError, JwtInvalidIssuerError, JwtInvalidSignatureAlgorithmError, JwtInvalidSignatureError,
  JwtNotBeforeError, JwtParseError, JwtWithoutValidKidError, KidNotFoundInJwksError } from 'aws-jwt-verify/error';
import { SimpleFetcher } from 'aws-jwt-verify/https';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { z } from 'zod';
import { authRequestOptions, AuthRequestBudget, BffAuthConfig } from './config';
import { BffAuthError, serviceAuthError } from './errors';

const usernameSchema = z.string().min(1).max(128)
  .refine(value => ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const credentialsSchema = z.strictObject({
  username: usernameSchema,
  password: z.string().min(1).max(256),
});

const identitySchema = z.strictObject({
  sub: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  tokenExpiresAt: z.number().int().positive().max(253_402_300_799),
});

export type LoginCredentials = Readonly<z.output<typeof credentialsSchema>>;
export type VerifiedCognitoIdentity = Readonly<z.output<typeof identitySchema>>;
export type CognitoAuthClient = Pick<CognitoIdentityProviderClient, 'send'>;

export interface CognitoAuthenticator {
  lookupAccount(email: string): Promise<{ readonly username: string; readonly sub: string }>;
  authenticate(credentials: unknown): Promise<VerifiedCognitoIdentity>;
}

/** Rejects malformed credentials with the same public failure used for denied logins. */
export function parseLoginCredentials(value: unknown): LoginCredentials {
  const result = credentialsSchema.safeParse(value);
  if (!result.success) throw new BffAuthError('authentication_failed');
  return result.data;
}

/** Creates a deadline-bounded canonical account lookup and cryptographically verified password adapter. */
export function createCognitoAuthenticator(config: BffAuthConfig, suppliedClient?: CognitoAuthClient, budget?: AuthRequestBudget): CognitoAuthenticator {
  const client = suppliedClient ?? new CognitoIdentityProviderClient({
    region: config.userPoolId.split('_')[0], maxAttempts: 2,
    requestHandler: { connectionTimeout: 500, requestTimeout: 8_000 },
  });

  const fetcher = new SimpleFetcher();

  const jwksCache = new SimpleJwksCache({ fetcher: {
    /** Uses the verifier's supported HTTPS signal/timeouts, keeping its bounded built-in retry. */
    async fetch(uri, options, data) {
      const { abortSignal } = authRequestOptions(budget);
      return fetcher.fetch(uri, { ...options, signal: abortSignal, timeout: 2_000,
        responseTimeout: Math.min(5_000, Math.max(1, (budget?.remainingMs() ?? 5_500) - 500)) }, data);
    },
  } });

  let verifier;
  try {
    verifier = CognitoJwtVerifier.create({ userPoolId: config.userPoolId, clientId: config.clientId, tokenUse: 'id' }, { jwksCache });
  } catch {
    throw new BffAuthError('invalid_configuration');
  }

  return {
    /** Resolves an email alias to one enabled, confirmed local account without trusting submitted subjects. */
    async lookupAccount(email: string): Promise<{ username: string; sub: string }> {

      try {
        const result = await client.send(new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: email }),
          authRequestOptions(budget));

        if (result.Enabled !== true) throw new BffAuthError('authentication_failed');
        if (result.UserStatus === 'UNCONFIRMED') throw new BffAuthError('account_not_confirmed');

        if (['FORCE_CHANGE_PASSWORD', 'RESET_REQUIRED'].includes(result.UserStatus ?? '')
          || result.PreferredMfaSetting || result.UserMFASettingList?.length || result.MFAOptions?.length) {
          throw new BffAuthError('authentication_challenge');
        }

        if (result.UserStatus !== 'CONFIRMED') throw new BffAuthError('authentication_failed');
        const username = usernameSchema.safeParse(result.Username);
        const subjects = result.UserAttributes?.filter(attribute => attribute.Name === 'sub') ?? [];
        const sub = identitySchema.shape.sub.safeParse(subjects[0]?.Value);
        if (!username.success || subjects.length !== 1 || !sub.success) throw new BffAuthError('session_unavailable');
        return { username: username.data, sub: sub.data };
      } catch (error) { throw serviceAuthError(error); }
    },
    /** Completes only unchallenged logins and discards all Cognito tokens after verification. */
    async authenticate(value: unknown): Promise<VerifiedCognitoIdentity> {
      const credentials = parseLoginCredentials(value);
      try {

        const result = await client.send(new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: config.clientId,
          AuthParameters: { USERNAME: credentials.username, PASSWORD: credentials.password },
        }), 
        
        authRequestOptions(budget));

        if (result.ChallengeName || result.Session) throw new BffAuthError('authentication_challenge');
        if (!result.AuthenticationResult?.IdToken) throw new BffAuthError('session_unavailable');
        const token = await verifier.verify(result.AuthenticationResult.IdToken);
        const identity = identitySchema.safeParse({ sub: token.sub, tokenExpiresAt: token.exp });
        if (!identity.success) throw new BffAuthError('authentication_failed');
        return identity.data;
      } 
      
      catch (error) {
        if ([CognitoJwtInvalidClientIdError, CognitoJwtInvalidTokenUseError, JwtExpiredError,
          JwtInvalidAudienceError, JwtInvalidIssuerError, JwtInvalidSignatureAlgorithmError, JwtInvalidSignatureError,
          JwtNotBeforeError, JwtParseError, JwtWithoutValidKidError, KidNotFoundInJwksError]
          .some(type => error instanceof type)) throw new BffAuthError('authentication_failed');
        // Network/JWKS/service outages map to safe unavailability, never a fabricated credential denial.
        throw serviceAuthError(error);
      }
    },
  };
}
