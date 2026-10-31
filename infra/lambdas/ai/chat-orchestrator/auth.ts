import { authSubSchema } from '../../frontend/auth/user-state';
import { ChatError, Configuration } from './config';

/** Narrows an untrusted REST proxy object without accepting arrays or primitives. */
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Resolves the admitted owner from a validated REST invocation before any persistence or streaming.
 * Frontend identity comes only from the session authorizer; the exact legacy API alone retains its shared owner.
 * Example input: a POST /api/chat proxy with matching account/stage/method/resource context and
 * authorizer { principalId: '<sub>', authenticationType: 'bff-session', userId: '<sub>', apiId: '<api-id>', stage: 'dev' }.
 * Output: '<sub>'. Missing/contradictory context throws; it never selects the legacy owner as a fallback.
 * API Gateway invocation permissions establish the source; a fabricated console event is not authentication.
 */
export function resolveOwner(raw: unknown, config: Configuration): string {
  const account = process.env.EXPECTED_ACCOUNT_ID ?? '';
  const legacyApiId = process.env.LEGACY_CHAT_API_ID ?? '';

  if (!/^[0-9]{12}$/.test(account) || !/^[a-z0-9]{1,128}$/.test(legacyApiId)
    || process.env.AWS_REGION !== config.region) {
    throw new ChatError('CONFIGURATION_ERROR', 'Chat is not available in this environment.', 503, false);
  }

  const event = object(raw);
  const context = object(event?.requestContext);
  const denied = () => new ChatError('UNAUTHORIZED', 'Authentication required.', 401, false);

  if (!event || event.version !== undefined || event.httpMethod !== 'POST' || context?.httpMethod !== 'POST'
    || context.accountId !== account || context.stage !== config.environment
    || typeof context.apiId !== 'string' || !/^[a-z0-9]{1,128}$/.test(context.apiId)
    || (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)
    || context.resourcePath !== event.resource || event.path !== event.resource) throw denied();

  if (context.apiId === legacyApiId) {
    // A legacy API can never be classified as authenticated Frontend traffic, even with forged context.
    if (event.resource !== '/chat' || (context.authorizer !== undefined && context.authorizer !== null)) throw denied();
    return config.ownerId;
  }

  const authorization = object(context.authorizer);
  const subject = authSubSchema.safeParse(authorization?.userId);
  if (event.resource !== '/api/chat' || authorization?.authenticationType !== 'bff-session'
    || !subject.success || authorization.principalId !== subject.data
    || authorization.apiId !== context.apiId || authorization.stage !== context.stage) throw denied();
  return subject.data;
}
