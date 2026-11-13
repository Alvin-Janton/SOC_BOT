/** Exact frontend origin-verification routes; these are not Cognito user authorization rules. */
export const FRONTEND_ORIGIN_ROUTES = [
  { route: 'health', method: 'GET', resource: '/api/health' },
  { route: 'login', method: 'POST', resource: '/api/auth/login' },
  { route: 'me', method: 'GET', resource: '/api/auth/me' },
  { route: 'logout', method: 'POST', resource: '/api/auth/logout' },
  { route: 'signup', method: 'POST', resource: '/api/auth/signup' },
  { route: 'confirm-signup', method: 'POST', resource: '/api/auth/confirm-signup' },
  { route: 'resend-confirmation', method: 'POST', resource: '/api/auth/resend-confirmation' },
  { route: 'forgot-password', method: 'POST', resource: '/api/auth/forgot-password' },
  { route: 'reset-password', method: 'POST', resource: '/api/auth/reset-password' },
  { route: 'change-password', method: 'POST', resource: '/api/auth/change-password' },
] as const;

/** Session-protected application routes, deliberately excluded from auth-Lambda route registration. */
export const FRONTEND_PROTECTED_ROUTES = [
  { route: 'chat', method: 'POST', resource: '/api/chat' },
  { route: 'conversations', method: 'GET', resource: '/api/conversations' },
  { route: 'conversation-messages', method: 'GET', resource: '/api/conversations/{conversationId}/messages' },
  { route: 'conversation-cancel', method: 'POST', resource: '/api/conversations/{conversationId}/turns/{turnId}/cancel' },
  { route: 'conversation-retry', method: 'GET', resource: '/api/conversations/{conversationId}/turns/{turnId}/retry' },
] as const;

export const CONVERSATION_MESSAGES_RESOURCE = '/api/conversations/{conversationId}/messages';
export const CONVERSATION_CANCEL_RESOURCE = '/api/conversations/{conversationId}/turns/{turnId}/cancel';

/** Resolves the same exact turn path while admitting only the cancellation POST body. */
export function conversationCancelPath(event: Record<string, unknown>): string | undefined {
  if (event.resource !== CONVERSATION_CANCEL_RESOURCE || typeof event.path !== 'string' || !event.path.endsWith('/cancel')) return undefined;
  const retryPath = conversationRetryPath({ ...event, resource: CONVERSATION_RETRY_RESOURCE, path: event.path.slice(0, -7) + '/retry', body: undefined });
  return retryPath ? retryPath.slice(0, -6) + '/cancel' : undefined;
}

export const CONVERSATION_RETRY_RESOURCE = '/api/conversations/{conversationId}/turns/{turnId}/retry';

/** Resolves exactly two safe IDs and rejects body/query input for the read-only retry preparation route. */
export function conversationRetryPath(event: Record<string, unknown>): string | undefined {
  const params = event.pathParameters;
  if (event.resource !== CONVERSATION_RETRY_RESOURCE || !params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).length !== 2 || !Object.hasOwn(params, 'conversationId') || !Object.hasOwn(params, 'turnId')
    || (event.body !== undefined && event.body !== null && event.body !== '')
    || (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)) return undefined;
  const { conversationId, turnId } = params as Record<string, unknown>;
  if (typeof conversationId !== 'string' || !conversationId.length || conversationId.length > 128 || /[^A-Za-z0-9_-]/.test(conversationId)
    || typeof turnId !== 'string' || turnId.length !== 36 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(turnId)) return undefined;
  for (const name of ['queryStringParameters', 'multiValueQueryStringParameters']) {
    const query = event[name];
    if (query !== undefined && query !== null && (typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length)) return undefined;
  }
  const path = `/api/conversations/${conversationId}/turns/${turnId}/retry`;
  return event.path === path ? path : undefined;
}

/** Resolves only the messages template's one bounded ID to its exact concrete path. */
export function conversationMessagesPath(event: Record<string, unknown>): string | undefined {
  const params = event.pathParameters;
  if (event.resource !== CONVERSATION_MESSAGES_RESOURCE || !params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).length !== 1 || !Object.hasOwn(params, 'conversationId')) return undefined;
  const id = (params as Record<string, unknown>).conversationId;
  if (typeof id !== 'string' || !id.length || id.length > 128 || /[^A-Za-z0-9_-]/.test(id)) return undefined;
  const path = `/api/conversations/${id}/messages`;
  return event.path === path ? path : undefined;
}

const GOOGLE_ORIGIN_ROUTES = [
  { route: 'google-start', method: 'GET', resource: '/api/auth/google/start' },
  { route: 'google-callback', method: 'GET', resource: '/api/auth/google/callback' },
  { route: 'google-link-start', method: 'POST', resource: '/api/auth/link/google/start' },
  { route: 'google-link-callback', method: 'GET', resource: '/api/auth/link/google/callback' },
] as const;

/** Includes only explicitly activated Google routes; password and health routes remain unchanged. */
export function frontendOriginRoutes(googleEnabled: boolean) {
  return googleEnabled ? [...FRONTEND_ORIGIN_ROUTES, ...GOOGLE_ORIGIN_ROUTES] : [...FRONTEND_ORIGIN_ROUTES];
}
