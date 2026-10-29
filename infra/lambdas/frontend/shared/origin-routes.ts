/** Exact frontend origin-verification routes; these are not Cognito user authorization rules. */
export const FRONTEND_ORIGIN_ROUTES = [
  { route: 'health', method: 'GET', resource: '/api/health' },
  { route: 'login', method: 'POST', resource: '/api/auth/login' },
  { route: 'me', method: 'GET', resource: '/api/auth/me' },
  { route: 'logout', method: 'POST', resource: '/api/auth/logout' },
] as const;
