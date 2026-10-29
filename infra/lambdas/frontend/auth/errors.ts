export type BffAuthErrorCode = 'invalid_configuration' | 'authentication_failed' | 'authentication_required' | 'session_unavailable'
  | 'invalid_input' | 'body_too_large' | 'unsupported_media_type' | 'invalid_origin' | 'account_not_confirmed'
  | 'authentication_challenge' | 'throttled';

const SAFE_ERRORS: Record<BffAuthErrorCode, { message: string; statusCode: number }> = {
  invalid_configuration: { message: 'Authentication is not configured.', statusCode: 503 },
  authentication_failed: { message: 'Email or password is incorrect.', statusCode: 401 },
  authentication_required: { message: 'Authentication required.', statusCode: 401 },
  session_unavailable: { message: 'Authentication is temporarily unavailable.', statusCode: 503 },
  invalid_input: { message: 'Invalid authentication request.', statusCode: 400 },
  body_too_large: { message: 'Request body is too large.', statusCode: 413 },
  unsupported_media_type: { message: 'Content-Type must be application/json.', statusCode: 415 },
  invalid_origin: { message: 'Request origin is not allowed.', statusCode: 403 },
  account_not_confirmed: { message: 'Account confirmation is required.', statusCode: 403 },
  authentication_challenge: { message: 'Additional authentication is not supported by this endpoint.', statusCode: 401 },
  throttled: { message: 'Too many authentication requests. Try again later.', statusCode: 429 },
};

/** Carries only safe public authentication details, without service errors or tokens. */
export class BffAuthError extends Error {
  public readonly statusCode: number;

  public constructor(public readonly code: BffAuthErrorCode) {
    super(SAFE_ERRORS[code].message);
    this.name = 'BffAuthError';
    this.statusCode = SAFE_ERRORS[code].statusCode;
  }
}

/** Maps only known provider categories to authored errors, discarding service details and causes. */
export function serviceAuthError(error: unknown): BffAuthError {
  if (error instanceof BffAuthError) return error;
  const name = error instanceof Error ? error.name : '';
  if (['TooManyRequestsException', 'ThrottlingException', 'ProvisionedThroughputExceededException',
    'RequestLimitExceeded', 'RequestLimitExceededException', 'LimitExceededException'].includes(name)) return new BffAuthError('throttled');
  if (['NotAuthorizedException', 'UserNotFoundException'].includes(name)) return new BffAuthError('authentication_failed');
  if (name === 'UserNotConfirmedException') return new BffAuthError('account_not_confirmed');
  if (name === 'PasswordResetRequiredException') return new BffAuthError('authentication_challenge');
  return new BffAuthError('session_unavailable');
}
