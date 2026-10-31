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
] as const;

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
