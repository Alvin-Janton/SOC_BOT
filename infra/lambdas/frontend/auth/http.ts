import { FRONTEND_ORIGIN_ROUTES } from '../shared/origin-routes';
import { BffAuthConfig, parseBffAuthConfig } from './config';
import { ConfirmationResend, EmailCredentials, parseConfirmationResend, parseEmailCredentials,
  parseSignupConfirmation, parseSignupCredentials, SignupConfirmation, SignupCredentials } from './contracts';
import { BffAuthError } from './errors';

export interface AuthHttpConfiguration {
  readonly auth: BffAuthConfig;
  readonly account: string;
  readonly apiId: string;
  readonly stage: 'dev' | 'demo';
  readonly browserOrigin: string;
}

export type AuthHttpRequest =
  | { readonly route: 'login'; readonly credentials: EmailCredentials }
  | { readonly route: 'signup'; readonly input: SignupCredentials }
  | { readonly route: 'confirm-signup'; readonly input: SignupConfirmation }
  | { readonly route: 'resend-confirmation'; readonly input: ConfirmationResend }
  | { readonly route: 'me' | 'logout'; readonly cookieHeader?: string; readonly invalidCookie: boolean };

export interface AuthHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: false;
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

  return { auth, account, apiId, stage, browserOrigin };
}

/** Reconciles equivalent proxy-header maps, rejecting repeated or conflicting critical headers. */
function header(event: Record<string, unknown>, name: string): string | undefined {
  const values: string[] = [];
  for (const mapName of ['headers', 'multiValueHeaders'] as const) {
    const raw = event[mapName];
    if (raw === null || raw === undefined) continue;
    const map = object(raw);
    if (!map) throw new BffAuthError('invalid_input');
    const entries = Object.entries(map).filter(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entries.length > 1) throw new BffAuthError('invalid_input');
    if (!entries.length) continue;
    const rawValue = entries[0][1];
    if (mapName === 'multiValueHeaders') {
      if (!Array.isArray(rawValue) || rawValue.length !== 1 || typeof rawValue[0] !== 'string') throw new BffAuthError('invalid_input');
      values.push(rawValue[0]);
    } else {
      if (typeof rawValue !== 'string') throw new BffAuthError('invalid_input');
      values.push(rawValue);
    }
  }
  if (values.some(value => [...value].some(character => (character.charCodeAt(0) < 32 && character !== '\t')
    || character.charCodeAt(0) === 127) || value !== values[0])) throw new BffAuthError('invalid_input');
  return values[0];
}

/** Enforces browser Origin and optional Fetch Metadata before either credential or session work. */
function browserRequest(event: Record<string, unknown>, method: string, expectedOrigin: string): void {
  try {
    const origin = header(event, 'Origin');
    const site = header(event, 'Sec-Fetch-Site');

    if ((origin !== undefined && origin !== expectedOrigin) || (method === 'POST' && origin === undefined)
      || (site !== undefined && !['same-origin', 'same-site', 'none'].includes(site.toLowerCase()))) {
      throw new BffAuthError('invalid_origin');
    }

  } catch {
    throw new BffAuthError('invalid_origin');
  }
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

  const selected = FRONTEND_ORIGIN_ROUTES.find(route => route.route !== 'health'
    && route.method === event.httpMethod && route.resource === event.resource);

  if (!selected || selected.route === 'health' || context.httpMethod !== selected.method
    || context.resourcePath !== selected.resource) throw new BffAuthError('invalid_input');

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
    case 'login': return { route: 'login', credentials: parseEmailCredentials(value) };
    case 'signup': return { route: 'signup', input: parseSignupCredentials(value) };
    case 'confirm-signup': return { route: 'confirm-signup', input: parseSignupConfirmation(value) };
    case 'resend-confirmation': return { route: 'resend-confirmation', input: parseConfirmationResend(value) };
    case 'logout': {
      const body = object(value);
      if (!body || Object.keys(body).length) throw new BffAuthError('invalid_input');
      break;
    }
    case 'me': break;
    default: throw new BffAuthError('invalid_input');
  }
  try { return { route: selected.route, cookieHeader: header(event, 'Cookie'), invalidCookie: false }; }
  catch { return { route: selected.route, invalidCookie: true }; }
}

/** Serializes only authored result/error bodies, with cookie output isolated in Set-Cookie. */
export function authHttpResponse(statusCode: number, value?: unknown, setCookie?: string): AuthHttpResponse {
  return { statusCode, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(statusCode === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...(setCookie === undefined ? {} : { 'Set-Cookie': setCookie }) },
  body: statusCode === 204 ? '' : JSON.stringify(value), isBase64Encoded: false };
}
