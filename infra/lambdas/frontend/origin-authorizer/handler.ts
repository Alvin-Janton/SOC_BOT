import { createOriginGuard, record } from '../shared/origin-guard';
import { FRONTEND_ORIGIN_ROUTES } from '../shared/origin-routes';

interface OriginConfiguration {
  readonly secretArn: string;
  readonly methodArn: string;
  readonly account: string;
  readonly apiId: string;
  readonly stage: 'dev' | 'demo';
}

interface AuthorizerPolicy {
  readonly principalId: 'cloudfront-origin';
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

  return { secretArn, methodArn, account: method[3], apiId: method[4], stage };
}

let guard: ReturnType<typeof createOriginGuard> | undefined;
let guardedSecretArn: string | undefined;

/** Returns an exact-method origin policy; this principal never represents a Cognito user. */
export async function handler(raw: unknown, context: { getRemainingTimeInMillis(): number }): Promise<AuthorizerPolicy> {
  try {
    const config = configuration();
    const event = record(raw);
    const requestContext = record(event?.requestContext);
    const route = FRONTEND_ORIGIN_ROUTES.find(candidate => candidate.method === event?.httpMethod && candidate.resource === event?.resource);
    const apiArn = config.methodArn.slice(0, config.methodArn.indexOf('/'));
    const methodArn = route ? `${apiArn}/${config.stage}/${route.method}${route.resource}` : undefined;

    if (!event || !methodArn || event.type !== 'REQUEST' || event.methodArn !== methodArn || requestContext?.apiId !== config.apiId
      || requestContext.stage !== config.stage || requestContext.accountId !== config.account) throw new Error('Unauthorized');

    if (!guard || guardedSecretArn !== config.secretArn) {
      guard = createOriginGuard(config.secretArn);
      guardedSecretArn = config.secretArn;
    }

    const allowed = await guard(event, context.getRemainingTimeInMillis());
    return { principalId: 'cloudfront-origin', policyDocument: {
      Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: allowed ? 'Allow' : 'Deny', Resource: methodArn }],
    } };
  }

  catch {
    // Never surface input, secret/configuration details, SDK responses or diagnostics.
    throw new Error('Unauthorized');
  }
}
