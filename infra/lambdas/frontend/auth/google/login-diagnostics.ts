import { CognitoJwtInvalidClientIdError, CognitoJwtInvalidTokenUseError, FetchError, JwtExpiredError,
  JwtInvalidAudienceError, JwtInvalidIssuerError, JwtInvalidSignatureAlgorithmError, JwtInvalidSignatureError,
  JwksNotAvailableInCacheError, WaitPeriodNotYetEndedJwkError } from 'aws-jwt-verify/error';
import { ZodError } from 'zod';
import { AuthStateInitializationConflict, BffAuthError } from '../errors';

const PHASES = ['callback_entry', 'transaction_consume', 'signed_out_check', 'callback_authorization', 'code_exchange',
  'jwt_verification', 'token_subject', 'token_username', 'token_claims', 'token_email', 'token_google_identity',
  'profile_lookup', 'profile_validation', 'user_state_read', 'user_state_initialize', 'user_state_reread',
  'user_auth_snapshot', 'session_create', 'response_construction', 'response_ready'] as const;
const CATEGORIES = ['validation_rejected', 'jwt_signature_invalid', 'jwt_issuer_invalid', 'jwt_audience_invalid',
  'jwt_token_use_invalid', 'jwt_expired', 'jwks_unavailable', 'schema_rejected', 'conditional_rejection', 'throttled',
  'deadline_or_transport', 'service_unavailable', 'unexpected', 'upstream_http_rejected', 'upstream_body_missing',
  'upstream_body_invalid', 'upstream_body_too_large', 'upstream_transport_failure'] as const;
const CHECKS = ['session_cookie_invalid', 'session_already_active', 'provider_cancelled', 'callback_authorization_rejected',
  'subject_invalid', 'username_invalid', 'nonce_type', 'nonce_mismatch', 'email_not_verified', 'expiry_invalid',
  'token_email_invalid', 'token_identity_shape', 'profile_disabled', 'profile_status_unsupported',
  'profile_username_mismatch', 'profile_mfa_present', 'profile_attribute_invalid', 'profile_subject_mismatch',
  'profile_email_unverified', 'profile_email_mismatch', 'profile_identity_mismatch'] as const;
export type GoogleLoginPhase = typeof PHASES[number];
export type GoogleLoginFailureCategory = typeof CATEGORIES[number];
export type GoogleLoginFailedCheck = typeof CHECKS[number];
type EmailVerifiedKind = 'boolean' | 'string' | 'missing' | 'other';
type IdentitiesKind = 'array' | 'string' | 'missing' | 'other';
type CallbackOutcome = 'GOOGLE_LOGIN_SUCCEEDED' | 'GOOGLE_LOGIN_FAILED' | 'SIGN_OUT_REQUIRED';

/** Optional request-local observation only; callers supply authored labels, never token/profile values. */
export interface GoogleLoginObserver {
  phase(value: GoogleLoginPhase): void;
  completed(value: GoogleLoginPhase): void;
  failure(category: GoogleLoginFailureCategory, check?: GoogleLoginFailedCheck): void;
  exchangeStatus(value: number): void;
  emailVerified(kind: EmailVerifiedKind, strictTrue: boolean): void;
  identities(kind: IdentitiesKind): void;
}

export interface GoogleLoginDiagnostics extends GoogleLoginObserver { emit(outcome: CallbackOutcome): void }

/** Maps known errors to constants without retaining names, messages, causes, assertions or SDK metadata. */
export function googleLoginFailureCategory(error: unknown): GoogleLoginFailureCategory {
  try {
    if (error instanceof AuthStateInitializationConflict) return 'conditional_rejection';
    if (error instanceof ZodError) return 'schema_rejected';
    if (error instanceof JwtInvalidSignatureError || error instanceof JwtInvalidSignatureAlgorithmError) return 'jwt_signature_invalid';
    if (error instanceof JwtInvalidIssuerError) return 'jwt_issuer_invalid';
    if (error instanceof JwtInvalidAudienceError || error instanceof CognitoJwtInvalidClientIdError) return 'jwt_audience_invalid';
    if (error instanceof CognitoJwtInvalidTokenUseError) return 'jwt_token_use_invalid';
    if (error instanceof JwtExpiredError) return 'jwt_expired';
    if (error instanceof FetchError || error instanceof JwksNotAvailableInCacheError || error instanceof WaitPeriodNotYetEndedJwkError) return 'jwks_unavailable';
    if (error instanceof BffAuthError) {
      if (error.code === 'throttled') return 'throttled';
      return error.statusCode >= 500 ? 'service_unavailable' : 'validation_rejected';
    }
    const name = error instanceof Error ? error.name : '';
    if (['TooManyRequestsException', 'ThrottlingException', 'ProvisionedThroughputExceededException',
      'RequestLimitExceeded', 'RequestLimitExceededException', 'LimitExceededException'].includes(name)) return 'throttled';
    if (name === 'ConditionalCheckFailedException') return 'conditional_rejection';
    if (['NotAuthorizedException', 'UserNotFoundException'].includes(name)) return 'validation_rejected';
    if (['AbortError', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException'].includes(name)) return 'deadline_or_transport';
    if (['ServiceUnavailableException', 'InternalErrorException', 'InternalServerError'].includes(name)) return 'service_unavailable';
    return 'unexpected';
  } catch { return 'unexpected'; }
}

/** Creates a temporary dev callback collector; the handler alone gates creation after trusted envelope validation. */
export function createGoogleLoginDiagnostics(requestId: string, startedAt: number): GoogleLoginDiagnostics | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || !Number.isSafeInteger(startedAt) || startedAt < 0) return undefined;
  let phase: GoogleLoginPhase = 'callback_entry';
  let lastCompletedPhase: GoogleLoginPhase | undefined;
  let failureCategory: GoogleLoginFailureCategory | undefined;
  let failedCheck: GoogleLoginFailedCheck | undefined;
  let exchangeHttpStatus: number | undefined;
  let tokenEmailVerifiedKind: EmailVerifiedKind | undefined;
  let tokenEmailVerifiedStrictTrue: boolean | undefined;
  let tokenIdentitiesKind: IdentitiesKind | undefined;
  let emitted = false;
  return {
    phase(value) { if (!failureCategory && PHASES.includes(value)) phase = value; },
    completed(value) { if (!failureCategory && PHASES.includes(value)) lastCompletedPhase = value; },
    failure(category, check) {
      if (failureCategory || !CATEGORIES.includes(category)) return;
      failureCategory = category;
      if (check !== undefined && CHECKS.includes(check)) failedCheck = check;
    },
    exchangeStatus(value) { if (Number.isInteger(value) && value >= 100 && value <= 599) exchangeHttpStatus = value; },
    emailVerified(kind, strictTrue) {
      if (['boolean', 'string', 'missing', 'other'].includes(kind) && typeof strictTrue === 'boolean') {
        tokenEmailVerifiedKind = kind; tokenEmailVerifiedStrictTrue = strictTrue;
      }
    },
    identities(kind) { if (['array', 'string', 'missing', 'other'].includes(kind)) tokenIdentitiesKind = kind; },
    emit(outcome) {
      if (emitted) return;
      emitted = true;
      try {
        const elapsed = Date.now() - startedAt;
        const record = JSON.stringify({ event: 'dev_google_login_diagnostic', requestId, route: 'google-callback',
          outcome: ['GOOGLE_LOGIN_SUCCEEDED', 'GOOGLE_LOGIN_FAILED', 'SIGN_OUT_REQUIRED'].includes(outcome) ? outcome : 'GOOGLE_LOGIN_FAILED',
          phase, lastCompletedPhase, failureCategory, failedCheck, exchangeHttpStatus, tokenEmailVerifiedKind,
          tokenEmailVerifiedStrictTrue, tokenIdentitiesKind,
          durationMs: Number.isFinite(elapsed) ? Math.min(60_000, Math.max(0, Math.floor(elapsed))) : 0 });
        if (Buffer.byteLength(record, 'utf8') < 4_096) console.info(record);
      } catch { /* Temporary telemetry must never replace a callback result. */ }
    },
  };
}
