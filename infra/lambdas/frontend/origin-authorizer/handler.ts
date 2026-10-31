import { createOriginGuard, record } from '../shared/origin-guard';
import { FRONTEND_PROTECTED_ROUTES, frontendOriginRoutes } from '../shared/origin-routes';
import { browserRequest, header } from '../shared/browser-request';
import { createAuthRequestBudget, parseBffAuthConfig } from '../auth/config';
import { readSessionCookie } from '../auth/cookies';
import { BffAuthError } from '../auth/errors';
import { createAuthSessionStore } from '../auth/sessions';
import { googleLoginEnabled } from '../auth/google/config';

interface OriginConfiguration {
  readonly secretArn: string;
  readonly methodArn: string;
  readonly account: string;
  readonly apiId: string;
  readonly stage: 'dev' | 'demo';
  readonly googleEnabled: boolean;
}

interface AuthorizerPolicy {
  readonly principalId: string;
  readonly context?: { readonly authenticationType: 'bff-session'; readonly userId: string; readonly apiId: string; readonly stage: 'dev' | 'demo' };
  readonly policyDocument: {
    readonly Version: '2012-10-17';
    readonly Statement: readonly [{ readonly Action: 'execute-api:Invoke'; readonly Effect: 'Allow' | 'Deny'; readonly Resource: string }];
  };
}

/** Checks ARN-only configuration against the expected environment, Region, account and health method. */
function configuration(): OriginConfiguration {
  const stage = process.env.DEPLOYMENT_ENVIRONMENT;
  const methodArn = process.env.ALLOWED_METHOD_ARN ?? '';
  const secretArn = process.env.ORIGIN_SECRET_ARN ?? '';
  const method = /^arn:(aws(?:-us-gov|-cn)?):execute-api:([a-z0-9-]+):([0-9]{12}):([a-z0-9]+)\/(dev|demo)\/GET\/api\/health$/.exec(methodArn);

  if ((stage !== 'dev' && stage !== 'demo') || !method || method[2] !== 'us-east-1'
    || method[2] !== process.env.AWS_REGION || method[5] !== stage) throw new Error('Unauthorized');

  const expectedSecret = `arn:${method[1]}:secretsmanager:${method[2]}:${method[3]}:secret:SOC-BOT-${stage.toUpperCase()}-FRONTEND-ORIGIN-TOKEN-`;

  if (!secretArn.startsWith(expectedSecret) || !/^[A-Za-z0-9]{6}$/.test(secretArn.slice(expectedSecret.length))) {
    throw new Error('Unauthorized');
  }

  const googleEnabled = googleLoginEnabled(process.env.GOOGLE_LOGIN_ENABLED);
  if (googleEnabled && stage !== 'dev') throw new Error('Unauthorized');
  return { secretArn, methodArn, account: method[3], apiId: method[4], stage, googleEnabled };
}

let guard: ReturnType<typeof createOriginGuard> | undefined;
let guardedSecretArn: string | undefined;

/** Builds an exact-method policy; only session-authenticated chat includes user context. */
function policy(methodArn: string, allowed: boolean, principalId = 'cloudfront-origin',
  context?: AuthorizerPolicy['context']): AuthorizerPolicy {
  return { principalId, ...(context ? { context } : {}), policyDocument: {
    Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: allowed ? 'Allow' : 'Deny', Resource: methodArn }],
  } };
}

/** Authenticates chat once at admission; health/auth keep origin-only authorization and error behavior. */
export async function handler(raw: unknown, context: { getRemainingTimeInMillis(): number }): Promise<AuthorizerPolicy> {
  const event = record(raw);
  const protectedRoute = FRONTEND_PROTECTED_ROUTES.find(candidate => candidate.method === event?.httpMethod && candidate.resource === event?.resource);
  let failure: 'Unauthorized' | 'Authorization unavailable';
  try {
    const config = configuration();
    const requestContext = record(event?.requestContext);
    const route = protectedRoute ?? frontendOriginRoutes(config.googleEnabled).find(candidate => candidate.method === event?.httpMethod && candidate.resource === event?.resource);
    const apiArn = config.methodArn.slice(0, config.methodArn.indexOf('/'));
    const methodArn = route ? `${apiArn}/${config.stage}/${route.method}${route.resource}` : undefined;

    if (!event || !methodArn || event.type !== 'REQUEST' || event.methodArn !== methodArn || requestContext?.apiId !== config.apiId
      || requestContext.stage !== config.stage || requestContext.accountId !== config.account
      || (protectedRoute && (requestContext.httpMethod !== route!.method || requestContext.resourcePath !== route!.resource))) throw new Error('Unauthorized');

    // One budget includes origin verification and both strongly consistent session/user reads.
    const budget = protectedRoute ? createAuthRequestBudget(context.getRemainingTimeInMillis()) : undefined;

    if (!guard || guardedSecretArn !== config.secretArn) {
      guard = createOriginGuard(config.secretArn, true);
      guardedSecretArn = config.secretArn;
    }

    let allowed: boolean;
    try { allowed = await guard(event, budget?.remainingMs() ?? context.getRemainingTimeInMillis(), budget?.signal); }

    catch (error) {
      if (protectedRoute) throw error;
      return policy(methodArn, false); // Preserve origin-only routes' existing secret-read failure response.
    }

    if (!protectedRoute || !allowed) return policy(methodArn, allowed);

    const browserOrigin = process.env.BROWSER_ORIGIN ?? '';

    const auth = parseBffAuthConfig({ userPoolId: process.env.USER_POOL_ID, clientId: process.env.USER_POOL_CLIENT_ID,
      sessionTableName: process.env.AUTH_SESSION_TABLE_NAME });

    if (!/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/.test(browserOrigin)
      || !auth.userPoolId.startsWith('us-east-1_')
      || auth.sessionTableName !== `SOC-BOT-${config.stage.toUpperCase()}-AUTH-SESSIONS`) throw new Error('Invalid configuration');

    try {
      browserRequest(event, 'POST', browserOrigin);
      const mode = header(event, 'Sec-Fetch-Mode');
      const destination = header(event, 'Sec-Fetch-Dest');
      if ((mode !== undefined && !['cors', 'same-origin'].includes(mode))
        || (destination !== undefined && destination !== 'empty')) return policy(methodArn, false);
    }

    catch { return policy(methodArn, false); }

    let token: string | undefined;
    try { token = readSessionCookie(header(event, 'Cookie')); }
    catch { throw new BffAuthError('authentication_required'); }
    if (!token) throw new BffAuthError('authentication_required');
    const session = await createAuthSessionStore(auth, undefined, undefined, budget).resolve(token);
    if (!session) throw new BffAuthError('authentication_required');

    return policy(methodArn, true, session.sub, {
      authenticationType: 'bff-session', userId: session.sub, apiId: config.apiId, stage: config.stage,
    });
  }

  catch (error) {
    // Never surface input, secret/configuration details, SDK responses or diagnostics.
    failure = !protectedRoute || (error instanceof BffAuthError && error.code === 'authentication_required')
      ? 'Unauthorized' : 'Authorization unavailable';
  }
  throw new Error(failure);
}
