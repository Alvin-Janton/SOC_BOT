import { CognitoAuthClient, createCognitoAuthenticator } from './cognito';
import { currentAuthTime, parseBffAuthConfig } from './config';
import { clearSessionCookie, createSessionCookie, readSessionCookie } from './cookies';
import { BffAuthError } from './errors';
import { AuthSession, AuthSessionClient, createAuthSessionStore } from './sessions';

export interface BffAuthDependencies {
  readonly cognitoClient?: CognitoAuthClient;
  readonly sessionClient?: AuthSessionClient;
  readonly nowSeconds?: () => number;
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
  login(credentials: unknown): Promise<LoginResult>;
  resolveSession(cookieHeader?: string): Promise<AuthSession | undefined>;
  requireSession(cookieHeader?: string): Promise<AuthSession>;
  logout(cookieHeader?: string): Promise<LogoutResult>;
}

/** Builds source-only BFF helpers; no handler, route, resource or orchestrator integration is registered. */
export function createBffAuth(configuration: unknown, dependencies: BffAuthDependencies = {}): BffAuthService {
  const config = parseBffAuthConfig(configuration);
  const nowSeconds = dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const cognito = createCognitoAuthenticator(config, dependencies.cognitoClient);
  const sessions = createAuthSessionStore(config, dependencies.sessionClient, nowSeconds);

  /** Resolves only the server-side opaque session and never calls Cognito for chat identity. */
  async function resolveSession(cookieHeader?: string): Promise<AuthSession | undefined> {
    const token = readSessionCookie(cookieHeader);
    return token === undefined ? undefined : sessions.resolve(token);
  }

  return {
    /** Authenticates, stores a trusted identity and returns an opaque cookie without Cognito tokens. */
    async login(credentials: unknown): Promise<LoginResult> {
      const identity = await cognito.authenticate(credentials);
      const session = await sessions.create(identity);
      const now = currentAuthTime(nowSeconds);
      if (session.expiresAt <= now) {
        await sessions.revoke(session.token);
        throw new BffAuthError('authentication_failed');
      }
      return {
        session: { sub: session.sub, expiresAt: session.expiresAt },
        setCookie: createSessionCookie(session.token, session.expiresAt, now, config.sameSite),
      };
    },

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
