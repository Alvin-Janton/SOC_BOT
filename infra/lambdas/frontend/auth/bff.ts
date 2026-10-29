import { CognitoAuthClient, createCognitoAuthenticator } from './cognito';
import { AuthRequestBudget, currentAuthTime, parseBffAuthConfig } from './config';
import { clearSessionCookie, createSessionCookie, readSessionCookie } from './cookies';
import { BffAuthError } from './errors';
import { AuthSession, AuthSessionClient, createAuthSessionStore } from './sessions';
import { createUserAuthStateStore, requireTrustedAuthenticationContext, TrustedAuthenticationContext } from './user-state';
import { createEmailPasswordLogin } from './login';

export interface BffAuthDependencies {
  readonly cognitoClient?: CognitoAuthClient;
  readonly sessionClient?: AuthSessionClient;
  readonly nowSeconds?: () => number;
  readonly budget?: AuthRequestBudget;
}

export interface LoginResult {
  readonly session: AuthSession;
  /** Forward through Set-Cookie only; do not include this header value in JSON or logs. */
  readonly setCookie: string;
}

export interface LogoutResult {
  readonly setCookie: string;
}

export interface BffAuthService {
  login(credentials: unknown, context: TrustedAuthenticationContext): Promise<LoginResult>;
  loginWithEmail(credentials: unknown): Promise<LoginResult>;
  resolveSession(cookieHeader?: string): Promise<AuthSession | undefined>;
  requireSession(cookieHeader?: string): Promise<AuthSession>;
  logout(cookieHeader?: string): Promise<LogoutResult>;
}

/** Builds session operations and the trusted first-login workflow without exposing provider tokens. */
export function createBffAuth(configuration: unknown, dependencies: BffAuthDependencies = {}): BffAuthService {
  const config = parseBffAuthConfig(configuration);
  const nowSeconds = dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const cognito = createCognitoAuthenticator(config, dependencies.cognitoClient, dependencies.budget);
  const sessions = createAuthSessionStore(config, dependencies.sessionClient, nowSeconds, dependencies.budget);
  const users = createUserAuthStateStore(config, dependencies.sessionClient, dependencies.budget);

  /** Resolves only the server-side opaque session and never calls Cognito for chat identity. */
  async function resolveSession(cookieHeader?: string): Promise<AuthSession | undefined> {
    const token = readSessionCookie(cookieHeader);
    return token === undefined ? undefined : sessions.resolve(token);
  }

  /** Authenticates against the original snapshot and sets a cookie only after confirmed persistence. */
  async function login(credentials: unknown, context: TrustedAuthenticationContext): Promise<LoginResult> {
    // This server-created snapshot must precede credential verification, never come from HTTP input.
    requireTrustedAuthenticationContext(context);
    const identity = await cognito.authenticate(credentials);
    const session = await sessions.create(identity, context);
    const now = currentAuthTime(nowSeconds);
    if (session.expiresAt <= now) {
      await sessions.revoke(session.token);
      throw new BffAuthError('authentication_failed');
    }
    return {
      session: { sub: session.sub, expiresAt: session.expiresAt },
      setCookie: createSessionCookie(session.token, session.expiresAt, now, config.sameSite),
    };
  }

  return {
    login,
    loginWithEmail: createEmailPasswordLogin(cognito, users, login),

    resolveSession,

    /** Requires an unexpired stored session before a future protected handler proceeds. */
    async requireSession(cookieHeader?: string): Promise<AuthSession> {
      const session = await resolveSession(cookieHeader);
      if (!session) throw new BffAuthError('authentication_required');
      return session;
    },

    /** Revokes a valid current session before clearing its cookie; malformed cookies are cleared only. */
    async logout(cookieHeader?: string): Promise<LogoutResult> {
      let token: string | undefined;
      try {
        token = readSessionCookie(cookieHeader);
      } catch (error) {
        if (!(error instanceof BffAuthError) || error.code !== 'authentication_required') throw error;
      }
      if (token !== undefined) await sessions.revoke(token);
      return { setCookie: clearSessionCookie(config.sameSite) };
    },
  };
}
