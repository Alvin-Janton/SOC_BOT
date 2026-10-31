import { browserRequest, header } from '../shared/browser-request';
import { frontendOriginRoutes } from '../shared/origin-routes';
import { GoogleLoginConfiguration, googleLoginConfiguration } from './google/config';
import { parseGoogleLinkStart } from './google/linking';
import { BffAuthConfig, parseBffAuthConfig } from './config';
import { ConfirmationResend, EmailCredentials, parseConfirmationResend, parseEmailCredentials,
  parsePasswordChange, parsePasswordReset, parseSignupConfirmation, parseSignupCredentials,
  PasswordChange, PasswordReset, SignupConfirmation, SignupCredentials } from './contracts';
import { BffAuthError } from './errors';

export interface AuthHttpConfiguration {
  readonly auth: BffAuthConfig;
  readonly account: string;
  readonly apiId: string;
  readonly stage: 'dev' | 'demo';
  readonly browserOrigin: string;
  readonly google?: GoogleLoginConfiguration;
}

export interface GoogleCallbackQuery { readonly state: string; readonly code?: string; readonly error?: string }

export type AuthHttpRequest =
  | { readonly route: 'google-start'; readonly cookieHeader?: string }
  | { readonly route: 'google-callback'; readonly cookieHeader?: string; readonly query: GoogleCallbackQuery }
  | { readonly route: 'google-link-start'; readonly cookieHeader?: string; readonly invalidCookie: boolean; readonly input: { readonly currentPassword: string } }
  | { readonly route: 'google-link-callback'; readonly cookieHeader?: string; readonly query: GoogleCallbackQuery }
  | { readonly route: 'login'; readonly credentials: EmailCredentials }
  | { readonly route: 'signup'; readonly input: SignupCredentials }
  | { readonly route: 'confirm-signup'; readonly input: SignupConfirmation }
  | { readonly route: 'resend-confirmation'; readonly input: ConfirmationResend }
  | { readonly route: 'forgot-password'; readonly input: ConfirmationResend }
  | { readonly route: 'reset-password'; readonly input: PasswordReset }
  | { readonly route: 'change-password'; readonly input: PasswordChange; readonly cookieHeader?: string; readonly invalidCookie: boolean }
  | { readonly route: 'me' | 'logout'; readonly cookieHeader?: string; readonly invalidCookie: boolean };

export interface AuthHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: false;
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[]>>;
}

/** Narrows untrusted proxy-event structures without adopting arrays or primitive values. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Loads environment-owned identifiers and the canonical distribution origin, never viewer-supplied hosts. */
export function authHttpConfiguration(): AuthHttpConfiguration {
  const stage = process.env.DEPLOYMENT_ENVIRONMENT;
  const account = process.env.EXPECTED_ACCOUNT_ID ?? '';
  const apiId = process.env.FRONTEND_API_ID ?? '';
  const browserOrigin = process.env.BROWSER_ORIGIN ?? '';
  const region = process.env.AWS_REGION;

  const auth = parseBffAuthConfig({ userPoolId: process.env.USER_POOL_ID, clientId: process.env.USER_POOL_CLIENT_ID,
    sessionTableName: process.env.AUTH_SESSION_TABLE_NAME });

  if ((stage !== 'dev' && stage !== 'demo') || !/^[0-9]{12}$/.test(account) || !/^[a-z0-9]{1,128}$/.test(apiId)
    || region !== 'us-east-1' || !auth.userPoolId.startsWith(`${region}_`)
    || auth.sessionTableName !== `SOC-BOT-${stage.toUpperCase()}-AUTH-SESSIONS`
    || !/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/.test(browserOrigin)) throw new BffAuthError('invalid_configuration');

  return { auth, account, apiId, stage, browserOrigin, google: googleLoginConfiguration(stage, account, browserOrigin) };
}

/** Reconciles bounded OAuth query maps, requiring one state and either a code or provider error. */
function googleCallbackQuery(event: Record<string, unknown>, directGoogle = false): GoogleCallbackQuery {
  const merged = new Map<string, string>();
  const keys = ['state', 'code', 'error', 'error_description', 'error_uri', ...(directGoogle ? ['scope', 'authuser', 'prompt', 'hd', 'iss'] : [])];
  for (const mapName of ['queryStringParameters', 'multiValueQueryStringParameters']) {
    const raw = event[mapName];
    if (raw === undefined || raw === null) continue;
    const map = object(raw);
    if (!map || Object.keys(map).length > keys.length) throw new BffAuthError('invalid_input');
    for (const [key, value] of Object.entries(map)) {
      if (!keys.includes(key)) throw new BffAuthError('invalid_input');
      const entry = mapName === 'multiValueQueryStringParameters'
        ? Array.isArray(value) && value.length === 1 ? value[0] : undefined : value;
      if (typeof entry !== 'string' || !entry.length || entry.length > (key === 'code' ? 4_096 : 1_024)
        || [...entry].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        || (key === 'iss' && entry !== 'https://accounts.google.com')
        || (merged.has(key) && merged.get(key) !== entry)) throw new BffAuthError('invalid_input');
      merged.set(key, entry);
    }
  }
  const state = merged.get('state');
  const code = merged.get('code');
  const error = merged.get('error');
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || Boolean(code) === Boolean(error)
    || (code && (merged.has('error_description') || merged.has('error_uri')))
    || Buffer.byteLength(JSON.stringify([...merged])) > 8_192) throw new BffAuthError('invalid_input');
  return { state, ...(code ? { code } : { error }) };
}

/** Allows only top-level OAuth navigation; cross-site entry is isolated to the bound callback. */
function googleBrowserRequest(event: Record<string, unknown>, config: AuthHttpConfiguration, callback: boolean, directGoogle = false): void {
  const mode = header(event, 'Sec-Fetch-Mode');
  const destination = header(event, 'Sec-Fetch-Dest');
  if ((mode !== undefined && mode !== 'navigate') || (destination !== undefined && destination !== 'document')) throw new BffAuthError('invalid_origin');
  if (!callback) browserRequest(event, 'GET', config.browserOrigin);
  else {
    const origin = header(event, 'Origin');
    if (origin !== undefined && origin !== config.browserOrigin
      && origin !== (directGoogle ? 'https://accounts.google.com' : config.google?.domain)) throw new BffAuthError('invalid_origin');
    header(event, 'Sec-Fetch-Site'); // Reject ambiguous metadata even though a cross-site callback is expected.
  }
}

/** Preserves strict cookie ambiguity handling only for routes that use a current session. */
function sessionCookie(event: Record<string, unknown>): { cookieHeader?: string; invalidCookie: boolean } {
  try { return { cookieHeader: header(event, 'Cookie'), invalidCookie: false }; }
  catch { return { invalidCookie: true }; }
}

/** Rejects URL parameters on these exact routes, including malformed proxy query maps. */
function noParameters(value: unknown): void {
  if (value === null || value === undefined) return;
  const map = object(value);
  if (!map || Object.keys(map).length) throw new BffAuthError('invalid_input');
}

/** Strictly decodes at most eight KiB of UTF-8, including canonical standard-base64 proxy bodies. */
function decodedBody(event: Record<string, unknown>): string {
  const raw = event.body;
  if (event.isBase64Encoded !== undefined && typeof event.isBase64Encoded !== 'boolean') throw new BffAuthError('invalid_input');

  if (raw === null || raw === undefined) {
    if (event.isBase64Encoded) throw new BffAuthError('invalid_input');
    return '';
  }

  if (typeof raw !== 'string') throw new BffAuthError('invalid_input');
  let bytes: Buffer;

  if (event.isBase64Encoded) {
    if (raw.length > Math.ceil(8_192 / 3) * 4) throw new BffAuthError('body_too_large');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw new BffAuthError('invalid_input');
    bytes = Buffer.from(raw, 'base64');
    if (bytes.toString('base64') !== raw) throw new BffAuthError('invalid_input');
  }

  else {
    if (Buffer.byteLength(raw, 'utf8') > 8_192) throw new BffAuthError('body_too_large');
    bytes = Buffer.from(raw, 'utf8');
  }

  if (bytes.length > 8_192) throw new BffAuthError('body_too_large');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new BffAuthError('invalid_input'); }
}

/** Validates the REST invocation, origin, exact route and operation-specific HTTP contract. */
export function parseAuthHttpRequest(raw: unknown, config: AuthHttpConfiguration): AuthHttpRequest {
  const event = object(raw);
  const context = object(event?.requestContext);
  const authorization = object(context?.authorizer);

  if (!event || event.version !== undefined || context?.apiId !== config.apiId || context.stage !== config.stage
    || context.accountId !== config.account || authorization?.principalId !== 'cloudfront-origin') throw new BffAuthError('invalid_origin');

  const selected = frontendOriginRoutes(config.google !== undefined).find(route => route.route !== 'health'
    && route.method === event.httpMethod && route.resource === event.resource);

  if (!selected || selected.route === 'health' || context.httpMethod !== selected.method
    || context.resourcePath !== selected.resource) throw new BffAuthError('invalid_input');

  if (selected.route === 'google-start' || selected.route === 'google-callback' || selected.route === 'google-link-callback') {
    googleBrowserRequest(event, config, selected.route !== 'google-start', selected.route === 'google-link-callback');
    noParameters(event.pathParameters);
    if (decodedBody(event) !== '') throw new BffAuthError('invalid_input');
    const cookieHeader = header(event, 'Cookie');
    if (selected.route === 'google-callback') return { route: selected.route, cookieHeader, query: googleCallbackQuery(event) };
    if (selected.route === 'google-link-callback') return { route: selected.route, cookieHeader, query: googleCallbackQuery(event, true) };
    noParameters(event.queryStringParameters);
    noParameters(event.multiValueQueryStringParameters);
    return { route: selected.route, cookieHeader };
  }
  browserRequest(event, selected.method, config.browserOrigin);
  noParameters(event.queryStringParameters);
  noParameters(event.multiValueQueryStringParameters);
  noParameters(event.pathParameters);

  if (selected.method === 'POST') {
    const mediaType = header(event, 'Content-Type');
    if (!mediaType || !/^[ \t]*application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*$/i.test(mediaType)) {
      throw new BffAuthError('unsupported_media_type');
    }
  }

  const text = decodedBody(event);
  let value: unknown;

  if (selected.route === 'me') {
    if (text !== '') throw new BffAuthError('invalid_input');
  }

  else {
    try { value = selected.route === 'logout' && text === '' ? {} : JSON.parse(text); }
    catch { throw new BffAuthError('invalid_input'); }
  }

  switch (selected.route) {
    case 'google-link-start': return { route: selected.route, input: parseGoogleLinkStart(value), ...sessionCookie(event) };
    case 'login': return { route: 'login', credentials: parseEmailCredentials(value) };
    case 'signup': return { route: 'signup', input: parseSignupCredentials(value) };
    case 'confirm-signup': return { route: 'confirm-signup', input: parseSignupConfirmation(value) };
    case 'resend-confirmation': return { route: 'resend-confirmation', input: parseConfirmationResend(value) };
    case 'forgot-password': return { route: 'forgot-password', input: parseConfirmationResend(value) };
    case 'reset-password': return { route: 'reset-password', input: parsePasswordReset(value) };
    case 'change-password': return { route: 'change-password', input: parsePasswordChange(value), ...sessionCookie(event) };
    case 'logout': {
      const body = object(value);
      if (!body || Object.keys(body).length) throw new BffAuthError('invalid_input');
      break;
    }
    case 'me': break;
    default: throw new BffAuthError('invalid_input');
  }
  return { route: selected.route, ...sessionCookie(event) };
}

/** Serializes only authored result/error bodies, with cookie output isolated in Set-Cookie. */
export function authHttpResponse(statusCode: number, value?: unknown, setCookie?: string): AuthHttpResponse {
  return { statusCode, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(statusCode === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...(setCookie === undefined ? {} : { 'Set-Cookie': setCookie }) },
  body: statusCode === 204 ? '' : JSON.stringify(value), isBase64Encoded: false };
}
