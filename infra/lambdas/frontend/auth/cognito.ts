import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { z } from 'zod';
import { BffAuthConfig } from './config';
import { BffAuthError } from './errors';

const credentialsSchema = z.strictObject({
  username: z.string().min(1).max(128).refine(value => ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)),
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
  authenticate(credentials: unknown): Promise<VerifiedCognitoIdentity>;
}

/** Rejects malformed credentials with the same public failure used for denied logins. */
export function parseLoginCredentials(value: unknown): LoginCredentials {
  const result = credentialsSchema.safeParse(value);
  if (!result.success) throw new BffAuthError('authentication_failed');
  return result.data;
}

/** Creates an inactive password-flow adapter that verifies ID tokens before trusting their sub. */
export function createCognitoAuthenticator(config: BffAuthConfig, suppliedClient?: CognitoAuthClient): CognitoAuthenticator {
  const client = suppliedClient ?? new CognitoIdentityProviderClient({ region: config.userPoolId.split('_')[0], maxAttempts: 2 });
  let verifier;
  try {
    verifier = CognitoJwtVerifier.create({ userPoolId: config.userPoolId, clientId: config.clientId, tokenUse: 'id' });
  } catch {
    throw new BffAuthError('invalid_configuration');
  }

  return {
    /** Completes only unchallenged logins and discards all Cognito tokens after verification. */
    async authenticate(value: unknown): Promise<VerifiedCognitoIdentity> {
      const credentials = parseLoginCredentials(value);
      try {
        const result = await client.send(new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: config.clientId,
          AuthParameters: { USERNAME: credentials.username, PASSWORD: credentials.password },
        }), { abortSignal: AbortSignal.timeout(10_000) });
        if (result.ChallengeName || result.Session || !result.AuthenticationResult?.IdToken) {
          throw new BffAuthError('authentication_failed');
        }
        const token = await verifier.verify(result.AuthenticationResult.IdToken);
        const identity = identitySchema.safeParse({ sub: token.sub, tokenExpiresAt: token.exp });
        if (!identity.success) throw new BffAuthError('authentication_failed');
        return identity.data;
      } catch {
        // Service names, challenges and JWT claim errors can reveal account state or tokens.
        throw new BffAuthError('authentication_failed');
      }
    },
  };
}
