export type BffAuthErrorCode = 'invalid_configuration' | 'authentication_failed' | 'authentication_required' | 'session_unavailable'
  | 'invalid_input' | 'body_too_large' | 'unsupported_media_type' | 'invalid_origin' | 'account_not_confirmed'
  | 'authentication_challenge' | 'throttled' | 'invalid_signup_password' | 'confirmation_failed'
  | 'registration_unavailable' | 'registration_throttled' | 'invalid_new_password' | 'password_reset_failed'
  | 'password_change_failed' | 'password_service_unavailable' | 'password_update_unconfirmed'
  | 'password_changed_session_revocation_unconfirmed' | 'google_login_failed' | 'sign_out_required';

const SAFE_ERRORS: Record<BffAuthErrorCode, { message: string; statusCode: number }> = {
  google_login_failed: { message: 'Google sign-in could not be completed. Try your existing sign-in method or account recovery.', statusCode: 401 },
  sign_out_required: { message: 'Sign out before starting another login.', statusCode: 409 },
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
  invalid_signup_password: { message: 'Use a password of 15 to 256 characters without whitespace.', statusCode: 400 },
  confirmation_failed: { message: 'The code could not be confirmed. Check it or request another code. If already confirmed, sign in.', statusCode: 400 },
  registration_unavailable: { message: 'Account confirmation is temporarily unavailable. Wait, then request another code if needed.', statusCode: 503 },
  registration_throttled: { message: 'Confirmation requests are temporarily limited. Wait, then request another code if needed.', statusCode: 429 },
  invalid_new_password: { message: 'Use a new password of 15 to 256 characters without whitespace.', statusCode: 400 },
  password_reset_failed: { message: 'The password could not be reset. Check the code or request another reset code.', statusCode: 400 },
  password_change_failed: { message: 'The current password could not be verified.', statusCode: 401 },
  password_service_unavailable: { message: 'Password services are temporarily unavailable. Try again later.', statusCode: 503 },
  password_update_unconfirmed: { message: 'Your password update could not be confirmed. Verify sign-in access, request a fresh recovery code, or contact the administrator instead of blindly repeating this request.', statusCode: 503 },
  password_changed_session_revocation_unconfirmed: { message: 'Your password was changed, but signing out existing sessions could not be confirmed. Contact the administrator.', statusCode: 503 },
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

/** Identifies a confirmed create-only metadata conflict without exposing provider diagnostics. */
export class AuthStateInitializationConflict extends BffAuthError {
  public constructor() { super('authentication_failed'); }
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
