import { BffAuthError } from '../errors';

export interface GoogleLoginConfiguration {
  readonly clientId: string;
  readonly domain: string;
  readonly redirectUri: string;
  readonly linking?: { readonly secretArn: string; readonly redirectUri: string };
}

/** Accepts only the explicit activation values used by CDK and the dev workflow. */
export function googleLoginEnabled(value: unknown): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new BffAuthError('invalid_configuration');
}

/** Loads public OAuth configuration separately from the password client's strict contract. */
export function googleLoginConfiguration(stage: 'dev' | 'demo', account: string, browserOrigin: string): GoogleLoginConfiguration | undefined {
  if (!googleLoginEnabled(process.env.GOOGLE_LOGIN_ENABLED)) return undefined;
  const clientId = process.env.GOOGLE_USER_POOL_CLIENT_ID ?? '';
  const domain = process.env.GOOGLE_COGNITO_DOMAIN ?? '';
  const redirectUri = process.env.GOOGLE_CALLBACK_URI ?? '';
  const linkRedirectUri = process.env.GOOGLE_LINK_CALLBACK_URI ?? '';
  const secretArn = process.env.GOOGLE_CREDENTIAL_SECRET_ARN ?? '';

  if (stage !== 'dev' || !/^[a-z0-9]{1,128}$/.test(clientId)
    || domain !== `https://soc-bot-dev-${account}-us-east-1.auth.us-east-1.amazoncognito.com`
    || redirectUri !== `${browserOrigin}/api/auth/google/callback`
    || linkRedirectUri !== `${browserOrigin}/api/auth/link/google/callback`
    || !new RegExp(`^arn:aws:secretsmanager:us-east-1:${account}:secret:SOC-BOT-DEV-GOOGLE-OAUTH-[A-Za-z0-9]{6}$`).test(secretArn)) throw new BffAuthError('invalid_configuration');

  return Object.freeze({ clientId, domain, redirectUri, linking: Object.freeze({ secretArn, redirectUri: linkRedirectUri }) });
}
