export type BffAuthErrorCode = 'invalid_configuration' | 'authentication_failed' | 'authentication_required' | 'session_unavailable';

const SAFE_ERRORS: Record<BffAuthErrorCode, { message: string; statusCode: number }> = {
  invalid_configuration: { message: 'Authentication is not configured.', statusCode: 503 },
  authentication_failed: { message: 'Authentication failed.', statusCode: 401 },
  authentication_required: { message: 'Authentication required.', statusCode: 401 },
  session_unavailable: { message: 'Authentication is temporarily unavailable.', statusCode: 503 },
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
