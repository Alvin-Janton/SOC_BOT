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
