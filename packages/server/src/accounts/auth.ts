import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { GoogleOptions } from 'better-auth/social-providers';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ACCOUNT_COOKIE_PREFIX } from '../auth/account-session.js';
import type { AccountsConfig } from '../config.js';
import type { Sql } from '../db/client.js';
import {
  authAccounts,
  authRateLimits,
  authVerifications,
  passkeys,
  sessions,
  users,
} from '../db/schema.js';

/**
 * Better Auth (accounts spec A2, 4.4, 4.11, 4.12). Only this module imports
 * it, and only the code that serves /account loads this module: the API
 * never does (`pnpm lint` checks it).
 *
 * People sign in with Google, or with a passkey they added after a first
 * Google sign-in. There are no passwords and no email sign-in.
 */

/**
 * The header the client's address arrives in, set by Retainer's own entry
 * code from the connection or API Gateway's source IP, never by the client
 * (routes.ts strips any it sends). Better Auth keys sign-in rate limits on it.
 */
export const CLIENT_IP_HEADER = 'x-retainer-client-ip';

export const SESSION_DAYS = 30;

/** Better Auth's models, mapped onto Retainer's tables (db/schema.ts). */
const MODELS = {
  users,
  sessions,
  auth_accounts: authAccounts,
  auth_verifications: authVerifications,
  passkeys,
  auth_rate_limits: authRateLimits,
};

/** Tests stand in for Google here; production uses Google's own checks. */
export type GoogleOverrides = Pick<GoogleOptions, 'verifyIdToken' | 'getUserInfo'>;

export type AuthOptions = {
  /** A connection as the control role. */
  sql: Sql;
  config: AccountsConfig;
  /** Where people reach Retainer, e.g. https://retainer.example. */
  publicOrigin: string;
  google?: GoogleOverrides;
  /** Off only in tests, which sign in many times from one address. */
  rateLimit?: boolean;
};

/** A signed-in person, as Better Auth reads their session. */
export type AccountSession = {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
    disabledAt?: Date | null | undefined;
  };
  session: { id: string; expiresAt: Date };
};

/** What the rest of `accounts` uses of Better Auth. */
export type Auth = {
  /** Better Auth's own routes, under /account/auth. */
  handler: (request: Request) => Promise<Response>;
  /** The session a request's cookie carries, or null. Writes nothing. */
  getSession: (headers: Headers) => Promise<AccountSession | null>;
};

export function createAuth(options: AuthOptions): Auth {
  const auth = betterAuthFor(options);
  return {
    handler: (request) => auth.handler(request),
    getSession: async (headers) => {
      const found = await auth.api.getSession({ headers });
      return found ? { user: found.user, session: found.session } : null;
    },
  };
}

function betterAuthFor(options: AuthOptions) {
  const { config, publicOrigin, sql } = options;
  const origin = new URL(publicOrigin);
  return betterAuth({
    appName: 'Retainer',
    baseURL: publicOrigin,
    basePath: '/account/auth',
    secret: config.secret,
    trustedOrigins: [origin.origin],
    database: drizzleAdapter(drizzle(sql), { provider: 'pg', schema: MODELS }),
    user: {
      modelName: 'users',
      additionalFields: {
        disabledAt: { type: 'date', required: false, input: false },
      },
    },
    session: {
      modelName: 'sessions',
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      // Reading a session writes nothing; the web app refreshes it with a
      // POST when it loads (4.4).
      deferSessionRefresh: true,
      // A cached cookie would keep a revoked session alive until it expires.
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'auth_accounts',
      // A person is their Google account, matched by Google's subject ID.
      // Another Google account with the same address is not merged in.
      accountLinking: { enabled: false },
    },
    verification: { modelName: 'auth_verifications' },
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        prompt: 'select_account',
        ...options.google,
      },
    },
    rateLimit: {
      enabled: options.rateLimit ?? true,
      // Counted in Postgres, so every function instance shares the limit.
      storage: 'database',
      modelName: 'auth_rate_limits',
    },
    advanced: {
      cookiePrefix: ACCOUNT_COOKIE_PREFIX,
      database: { generateId: 'uuid' },
      // Strict on the session cookie alone: Google's callback is a redirect
      // from another site, so the OAuth state cookie stays Lax (4.6).
      cookies: { session_token: { attributes: { sameSite: 'strict' } } },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    databaseHooks: {
      user: {
        create: {
          // Invitations compare against the address, so it must be one
          // Google verified. Addresses are kept lowercase.
          before: async (user) => {
            if (!user.emailVerified) return false;
            return { data: { ...user, email: user.email.toLowerCase() } };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [user] = await sql<{ disabled: boolean }[]>`
              select disabled_at is not null as disabled from users where id = ${session.userId}`;
            if (user?.disabled) return false;
            return { data: session };
          },
        },
      },
    },
    plugins: [
      passkey({
        // Passkeys belong to one domain forever (4.11): the public origin's.
        rpID: origin.hostname,
        rpName: 'Retainer',
        origin: origin.origin,
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        schema: { passkey: { modelName: 'passkeys' } },
      }),
    ],
  });
}
