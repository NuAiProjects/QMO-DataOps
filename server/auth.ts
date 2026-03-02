import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { Strategy as GoogleOIDCStrategy } from "passport-google-oidc";
import { Issuer, Strategy as OpenIDConnectStrategy } from "openid-client";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "./db";
import { getDevUser } from "./dev-auth";
import {
  authIdentities,
  units,
  userPasswordCredentials,
  userUnits,
  users,
} from "@shared/schema";
import { logAudit } from "./audit";

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required.");
}
const sessionSecret: string = SESSION_SECRET;

const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5000";
type VerifyCallback = (err: any, user?: any, info?: any) => void;

const LOGIN_WINDOW_MS = Number(process.env.AUTH_LOGIN_WINDOW_MS || 10 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS || 5);
const AUTH_RATE_LIMIT_ENABLED =
  process.env.NODE_ENV === "production" || process.env.AUTH_LOGIN_RATE_LIMIT === "true";
const AUTH_RATE_LIMIT_STORE = process.env.AUTH_LOGIN_RATE_LIMIT_STORE || "db";
const USE_PERSISTENT_RATE_LIMIT = AUTH_RATE_LIMIT_STORE !== "memory";

const LOCAL_AUTH_CREDENTIALS_JSON = process.env.LOCAL_AUTH_CREDENTIALS_JSON;
const PASSWORD_MIN_LENGTH = Number(process.env.AUTH_PASSWORD_MIN_LENGTH || 10);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_ALGO_TAG = "scrypt_v1";

type LoginAttemptState = {
  count: number;
  firstAttemptAt: number;
  blockedUntil: number | null;
};

const loginAttempts = new Map<string, LoginAttemptState>();
let rateLimitTableReady: Promise<void> | null = null;
let passwordCredentialTableReady: Promise<void> | null = null;

function normalizeLoginAlias(value: string) {
  return value.trim().toLowerCase();
}

function toNullableEpoch(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  const epoch = date.getTime();
  return Number.isNaN(epoch) ? null : epoch;
}

function parseLocalCredentials(raw: string | undefined) {
  const credentials = new Map<string, string>();
  if (!raw) return credentials;
  try {
    const parsed = JSON.parse(raw) as
      | Record<string, string>
      | Array<{ username?: string; password?: string; aliases?: string[] }>;

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry?.username || !entry?.password) continue;
        const password = String(entry.password).trim();
        if (!password) continue;
        credentials.set(normalizeLoginAlias(entry.username), password);
        for (const alias of entry.aliases || []) {
          credentials.set(normalizeLoginAlias(alias), password);
        }
      }
      return credentials;
    }

    for (const [username, password] of Object.entries(parsed)) {
      if (!username || !password) continue;
      const normalizedPassword = String(password).trim();
      if (!normalizedPassword) continue;
      credentials.set(normalizeLoginAlias(username), normalizedPassword);
    }
  } catch (error) {
    console.error("Failed to parse LOCAL_AUTH_CREDENTIALS_JSON", error);
  }
  return credentials;
}

const LOCAL_AUTH_CREDENTIALS = parseLocalCredentials(LOCAL_AUTH_CREDENTIALS_JSON);

function getUserLoginAliases(email: string) {
  const normalized = normalizeLoginAlias(email);
  const prefix = normalized.split("@")[0] || normalized;
  return [normalized, prefix];
}

function getSeedPasswordForUser(email: string) {
  for (const alias of getUserLoginAliases(email)) {
    const configured = LOCAL_AUTH_CREDENTIALS.get(alias);
    if (configured) return configured;
  }
  return null;
}

function assertPasswordStrength(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
}

function hashPassword(password: string) {
  assertPasswordStrength(password);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `${SCRYPT_ALGO_TAG}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyHashedPassword(password: string, encodedHash: string) {
  const [algo, nStr, rStr, pStr, saltB64, hashB64] = encodedHash.split("$");
  if (algo !== SCRYPT_ALGO_TAG || !nStr || !rStr || !pStr || !saltB64 || !hashB64) {
    return false;
  }
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, salt, expected.length, {
    N: n,
    r,
    p,
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function ensurePasswordCredentialTable() {
  if (!passwordCredentialTableReady) {
    passwordCredentialTableReady = db
      .execute(sql`
        create table if not exists user_password_credentials (
          user_id uuid primary key references users(id) on delete cascade,
          password_hash text not null,
          password_algo text not null default 'scrypt_v1',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          updated_by uuid references users(id) on delete set null
        )
      `)
      .then(() => undefined)
      .catch((error) => {
        passwordCredentialTableReady = null;
        throw error;
      });
  }
  await passwordCredentialTableReady;
}

export async function setUserPasswordCredential(params: {
  userId: string;
  plainPassword: string;
  updatedByUserId?: string | null;
}) {
  await ensurePasswordCredentialTable();
  const passwordHash = hashPassword(params.plainPassword);
  await db
    .insert(userPasswordCredentials)
    .values({
      userId: params.userId,
      passwordHash,
      passwordAlgo: SCRYPT_ALGO_TAG,
      updatedBy: params.updatedByUserId ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userPasswordCredentials.userId],
      set: {
        passwordHash,
        passwordAlgo: SCRYPT_ALGO_TAG,
        updatedBy: params.updatedByUserId ?? null,
        updatedAt: new Date(),
      },
    });
}

async function getUserPasswordHash(userId: string) {
  await ensurePasswordCredentialTable();
  const [credential] = await db
    .select({ passwordHash: userPasswordCredentials.passwordHash })
    .from(userPasswordCredentials)
    .where(eq(userPasswordCredentials.userId, userId))
    .limit(1);
  return credential?.passwordHash || null;
}

async function hasAnyPasswordCredentials() {
  await ensurePasswordCredentialTable();
  const rows = await db
    .select({ userId: userPasswordCredentials.userId })
    .from(userPasswordCredentials)
    .limit(1);
  return rows.length > 0;
}

export async function getUserIdsWithPasswordCredentials(userIds: string[]) {
  if (userIds.length === 0) return new Set<string>();
  await ensurePasswordCredentialTable();
  const rows = await db
    .select({ userId: userPasswordCredentials.userId })
    .from(userPasswordCredentials)
    .where(inArray(userPasswordCredentials.userId, userIds));
  return new Set(rows.map((row) => row.userId));
}

export async function verifyUserPasswordCredential(userId: string, plainPassword: string) {
  const passwordHash = await getUserPasswordHash(userId);
  if (!passwordHash) return false;
  return verifyHashedPassword(plainPassword, passwordHash);
}

async function seedPasswordCredentialsFromEnv() {
  if (LOCAL_AUTH_CREDENTIALS.size === 0) return;
  await ensurePasswordCredentialTable();
  const allUsers = await db.select().from(users);
  for (const user of allUsers) {
    const seedPassword = getSeedPasswordForUser(user.email);
    if (!seedPassword) continue;
    const existing = await getUserPasswordHash(user.id);
    if (existing) continue;
    await setUserPasswordCredential({
      userId: user.id,
      plainPassword: seedPassword,
      updatedByUserId: user.id,
    });
  }
}

function getLoginAttemptKey(req: Request, username: string) {
  const ip = req.ip || "unknown";
  return `${ip}::${username.toLowerCase()}`;
}

async function ensureLoginRateLimitTable() {
  if (!USE_PERSISTENT_RATE_LIMIT) return;
  if (!rateLimitTableReady) {
    rateLimitTableReady = db
      .execute(sql`
        create table if not exists auth_login_attempts (
          attempt_key text primary key,
          attempt_count integer not null,
          first_attempt_at timestamptz not null,
          blocked_until timestamptz,
          updated_at timestamptz not null default now()
        )
      `)
      .then(() => undefined)
      .catch((error) => {
        rateLimitTableReady = null;
        throw error;
      });
  }
  await rateLimitTableReady;
}

async function getPersistentLoginAttempt(key: string) {
  await ensureLoginRateLimitTable();
  const result = await db.execute(sql`
    select attempt_count, first_attempt_at, blocked_until
    from auth_login_attempts
    where attempt_key = ${key}
    limit 1
  `);
  const row = (result as any).rows?.[0] as
    | {
        attempt_count?: unknown;
        first_attempt_at?: unknown;
        blocked_until?: unknown;
      }
    | undefined;
  if (!row) return null;
  const firstAttemptAt = toNullableEpoch(row.first_attempt_at);
  const attemptCount = Number(row.attempt_count);
  if (!firstAttemptAt || !Number.isFinite(attemptCount)) return null;
  return {
    count: attemptCount,
    firstAttemptAt,
    blockedUntil: toNullableEpoch(row.blocked_until),
  } satisfies LoginAttemptState;
}

async function setPersistentLoginAttempt(key: string, state: LoginAttemptState) {
  await ensureLoginRateLimitTable();
  await db.execute(sql`
    insert into auth_login_attempts (
      attempt_key,
      attempt_count,
      first_attempt_at,
      blocked_until,
      updated_at
    )
    values (
      ${key},
      ${state.count},
      ${new Date(state.firstAttemptAt)},
      ${state.blockedUntil ? new Date(state.blockedUntil) : null},
      now()
    )
    on conflict (attempt_key) do update
      set attempt_count = excluded.attempt_count,
          first_attempt_at = excluded.first_attempt_at,
          blocked_until = excluded.blocked_until,
          updated_at = now()
  `);
}

async function clearPersistentLoginAttempt(key: string) {
  await ensureLoginRateLimitTable();
  await db.execute(sql`
    delete from auth_login_attempts
    where attempt_key = ${key}
  `);
}

async function pruneExpiredPersistentLoginAttempts(now = Date.now()) {
  await ensureLoginRateLimitTable();
  const oldWindow = new Date(now - LOGIN_WINDOW_MS * 2);
  const oldBlock = new Date(now - LOGIN_WINDOW_MS);
  await db.execute(sql`
    delete from auth_login_attempts
    where
      (blocked_until is null and first_attempt_at < ${oldWindow})
      or
      (blocked_until is not null and blocked_until < ${oldBlock})
  `);
}

function pruneExpiredLoginAttempts(now = Date.now()) {
  for (const [key, value] of loginAttempts.entries()) {
    const blockedExpired = !value.blockedUntil || value.blockedUntil <= now;
    if (now - value.firstAttemptAt > LOGIN_WINDOW_MS && blockedExpired) {
      loginAttempts.delete(key);
    }
  }
}

async function getLoginAttemptState(key: string) {
  if (USE_PERSISTENT_RATE_LIMIT) {
    return getPersistentLoginAttempt(key);
  }
  return loginAttempts.get(key) || null;
}

async function setLoginAttemptState(key: string, state: LoginAttemptState) {
  if (USE_PERSISTENT_RATE_LIMIT) {
    await setPersistentLoginAttempt(key, state);
    return;
  }
  loginAttempts.set(key, state);
}

async function getRemainingBlockMs(key: string, now = Date.now()) {
  const attempts = await getLoginAttemptState(key);
  if (!attempts) return 0;

  if (attempts.blockedUntil && attempts.blockedUntil > now) {
    return attempts.blockedUntil - now;
  }

  const elapsed = now - attempts.firstAttemptAt;
  if (elapsed >= LOGIN_WINDOW_MS) {
    await clearLoginAttempts(key);
    return 0;
  }

  if (attempts.count < LOGIN_MAX_ATTEMPTS) return 0;

  const remaining = LOGIN_WINDOW_MS - elapsed;
  if (remaining <= 0) {
    await clearLoginAttempts(key);
    return 0;
  }
  return remaining;
}

async function recordFailedLoginAttempt(key: string, now = Date.now()) {
  const existing = await getLoginAttemptState(key);
  const isExpired = !existing || now - existing.firstAttemptAt > LOGIN_WINDOW_MS;

  const nextCount = isExpired ? 1 : existing.count + 1;
  const nextFirstAttemptAt = isExpired ? now : existing.firstAttemptAt;
  const shouldBlock = nextCount >= LOGIN_MAX_ATTEMPTS;
  const blockedUntil = shouldBlock ? now + LOGIN_WINDOW_MS : null;

  await setLoginAttemptState(key, {
    count: nextCount,
    firstAttemptAt: nextFirstAttemptAt,
    blockedUntil,
  });
}

async function clearLoginAttempts(key: string) {
  if (USE_PERSISTENT_RATE_LIMIT) {
    await clearPersistentLoginAttempt(key);
    return;
  }
  loginAttempts.delete(key);
}

function getGoogleCallbackUrl() {
  return (
    process.env.GOOGLE_CALLBACK_URL ||
    `${APP_BASE_URL}/api/auth/login/google/callback`
  );
}

function getMicrosoftCallbackUrl() {
  return (
    process.env.MICROSOFT_CALLBACK_URL ||
    `${APP_BASE_URL}/api/auth/login/microsoft/callback`
  );
}

async function findUserByEmail(email: string) {
  const normalizedEmail = email.toLowerCase();
  const [user] = await db
    .select()
    .from(users)
    .where(ilike(users.email, normalizedEmail))
    .limit(1);
  return user;
}

async function findUserByUsername(username: string) {
  const normalized = username.toLowerCase();
  const exactUser = await findUserByEmail(normalized);
  if (exactUser) return exactUser;

  if (normalized.includes("@")) {
    return undefined;
  }

  const [matchByPrefix] = await db
    .select()
    .from(users)
    .where(ilike(users.email, `${normalized}@%`))
    .limit(1);
  return matchByPrefix;
}

async function upsertAuthIdentity(params: {
  userId: string;
  provider: "google" | "microsoft";
  providerSubject: string;
  email: string;
}) {
  await db
    .insert(authIdentities)
    .values({
      userId: params.userId,
      provider: params.provider,
      providerSubject: params.providerSubject,
      email: params.email,
    })
    .onConflictDoUpdate({
      target: [authIdentities.provider, authIdentities.providerSubject],
      set: {
        userId: params.userId,
        email: params.email,
      },
    });
}

export async function configureAuth(app: Express) {
  const PgStore = connectPgSimple(session);
  try {
    await ensurePasswordCredentialTable();
    await seedPasswordCredentialsFromEnv();
  } catch (error) {
    console.error("Failed to initialize password credential store.", error);
    throw error;
  }
  if (AUTH_RATE_LIMIT_ENABLED && USE_PERSISTENT_RATE_LIMIT) {
    try {
      await ensureLoginRateLimitTable();
    } catch (error) {
      console.error("Failed to initialize persistent login rate-limit store.", error);
      throw error;
    }
  }

  app.set("trust proxy", 1);
  app.use(
    session({
      store: new PgStore({
        pool,
        tableName: "session",
        createTableIfMissing: true,
      }),
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 12,
      },
    }),
  );

  app.use(passport.initialize());
  app.use(passport.session());

  passport.serializeUser((user: Express.User, done) => {
    done(null, (user as { id: string }).id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      if (!user || !user.isActive) {
        return done(null, false);
      }

      return done(null, user);
    } catch (error) {
      return done(error);
    }
  });

  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (googleClientId && googleClientSecret) {
    passport.use(
      "google",
      new GoogleOIDCStrategy(
        {
          clientID: googleClientId,
          clientSecret: googleClientSecret,
          callbackURL: getGoogleCallbackUrl(),
          scope: ["openid", "profile", "email"],
        },
        async (
          _issuer: string,
          profile: { id?: string; emails?: Array<{ value?: string }> },
          done: VerifyCallback,
        ) => {
          try {
            const email = profile?.emails?.[0]?.value?.toLowerCase();
            const subject = profile?.id;
            if (!email || !subject) {
              return done(null, false, { message: "No email from Google." });
            }

            const user = await findUserByEmail(email);
            if (!user || !user.isActive) {
              return done(null, false, { message: "User not provisioned." });
            }

            await upsertAuthIdentity({
              userId: user.id,
              provider: "google",
              providerSubject: subject,
              email,
            });

            return done(null, user);
          } catch (error) {
            return done(error);
          }
        },
      ) as any,
    );
  } else {
    console.warn("Google SSO not configured. Set GOOGLE_CLIENT_ID/SECRET to enable.");
  }

  const microsoftClientId = process.env.MICROSOFT_CLIENT_ID;
  const microsoftClientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  let microsoftSsoEnabled = false;

  if (microsoftClientId && microsoftClientSecret) {
    try {
      const tenantId = process.env.MICROSOFT_TENANT_ID || "common";
      const microsoftIssuer = await Issuer.discover(
        `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`,
      );
      const microsoftClient = new microsoftIssuer.Client({
        client_id: microsoftClientId,
        client_secret: microsoftClientSecret,
        redirect_uris: [getMicrosoftCallbackUrl()],
        response_types: ["code"],
      });

      passport.use(
        "microsoft",
        new OpenIDConnectStrategy(
          {
            client: microsoftClient,
            params: { scope: "openid profile email" },
          },
          async (
            tokenSet: { claims: () => Record<string, any> },
            userinfo: { email?: string } | undefined,
            done: VerifyCallback,
          ) => {
            try {
              const claims = tokenSet.claims();
              const email = (
                userinfo?.email ||
                claims.email ||
                claims.preferred_username
              )?.toLowerCase();
              const subject = claims.sub;

              if (!email || !subject) {
                return done(null, false, { message: "No email from Microsoft." });
              }

              const user = await findUserByEmail(email);
              if (!user || !user.isActive) {
                return done(null, false, { message: "User not provisioned." });
              }

              await upsertAuthIdentity({
                userId: user.id,
                provider: "microsoft",
                providerSubject: subject,
                email,
              });

              return done(null, user);
            } catch (error) {
              return done(error);
            }
          },
        ),
      );
      microsoftSsoEnabled = true;
    } catch (error) {
      console.warn(
        "Microsoft SSO discovery failed. Continuing without Microsoft login.",
        error,
      );
    }
  } else {
    console.warn(
      "Microsoft SSO not configured. Set MICROSOFT_CLIENT_ID/SECRET to enable.",
    );
  }

  app.get("/api/auth/login/google", (req, res, next) => {
    if (!googleClientId || !googleClientSecret) {
      return res.status(503).json({ message: "Google SSO not configured." });
    }
    return passport.authenticate("google", {
      scope: ["openid", "profile", "email"],
    })(req, res, next);
  });

  app.get(
    "/api/auth/login/google/callback",
    (req, res, next) => {
      if (!googleClientId || !googleClientSecret) {
        return res.redirect("/login?error=oauth_not_configured");
      }
      return passport.authenticate("google", {
        failureRedirect: "/login?error=unauthorized",
        failureMessage: true,
      })(req, res, next);
    },
    (_req: Request, res: Response) => {
      res.redirect("/");
    },
  );

  app.get("/api/auth/providers", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const passwordEnabled = await hasAnyPasswordCredentials();
    res.json({
      google: Boolean(googleClientId && googleClientSecret),
      microsoft: microsoftSsoEnabled,
      password: passwordEnabled,
    });
  });

  app.post("/api/auth/login/password", async (req: Request, res: Response, next: NextFunction) => {
    const parsed = z
      .object({
        username: z.string().trim().min(1, "Username is required."),
        password: z.string().trim().min(1, "Password is required."),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ message: "Username and password are required." });
    }

    if (!(await hasAnyPasswordCredentials())) {
      return res.status(503).json({
        message: "Password login is not configured.",
      });
    }

    const username = parsed.data.username.toLowerCase();
    const attemptKey = getLoginAttemptKey(req, username);
    if (AUTH_RATE_LIMIT_ENABLED) {
      if (USE_PERSISTENT_RATE_LIMIT && Math.random() < 0.05) {
        void pruneExpiredPersistentLoginAttempts().catch((error) => {
          console.error("Failed to prune persistent login attempts", error);
        });
      } else {
        pruneExpiredLoginAttempts();
      }

      const remainingBlockMs = await getRemainingBlockMs(attemptKey);
      if (remainingBlockMs > 0) {
        const retryAfterSeconds = Math.max(1, Math.ceil(remainingBlockMs / 1000));
        res.setHeader("Retry-After", retryAfterSeconds.toString());
        return res.status(429).json({
          message: `Too many login attempts. Try again in ${retryAfterSeconds} second(s).`,
        });
      }
    }

    const user = await findUserByUsername(username);
    if (!user || !user.isActive) {
      if (AUTH_RATE_LIMIT_ENABLED) {
        await recordFailedLoginAttempt(attemptKey);
      }
      await logAudit({
        actorUserId: null,
        action: "auth.login.failed",
        entityType: "auth_session",
        entityId: null,
        afterJson: { username, reason: "invalid_credentials" },
        ip: req.ip,
      });
      return res.status(401).json({
        message: "Invalid username or password.",
      });
    }

    const submittedPassword = parsed.data.password.trim();
    const passwordMatches = await verifyUserPasswordCredential(user.id, submittedPassword);

    if (!passwordMatches) {
      if (AUTH_RATE_LIMIT_ENABLED) {
        await recordFailedLoginAttempt(attemptKey);
      }
      await logAudit({
        actorUserId: user.id,
        action: "auth.login.failed",
        entityType: "auth_session",
        entityId: null,
        afterJson: { username, reason: "invalid_credentials" },
        ip: req.ip,
      });
      return res.status(401).json({
        message: "Invalid username or password.",
      });
    }

    req.session.regenerate((regenErr) => {
      if (regenErr) return next(regenErr);

      req.login(user, (err) => {
        if (err) return next(err);
        void clearLoginAttempts(attemptKey).catch((clearError) => {
          console.error("Failed to clear login attempts", clearError);
        });
        void logAudit({
          actorUserId: user.id,
          action: "auth.login.success",
          entityType: "auth_session",
          entityId: null,
          ip: req.ip,
        }).catch((auditError) => {
          console.error("auth.login.success audit error", auditError);
        });
        return res.json({ ok: true });
      });
    });
  });

  app.get("/api/auth/login/microsoft", (req, res, next) => {
    if (!microsoftSsoEnabled) {
      return res.status(503).json({ message: "Microsoft SSO not configured." });
    }
    return passport.authenticate("microsoft")(req, res, next);
  });

  app.get(
    "/api/auth/login/microsoft/callback",
    (req, res, next) => {
      if (!microsoftSsoEnabled) {
        return res.redirect("/login?error=oauth_not_configured");
      }
      return passport.authenticate("microsoft", {
        failureRedirect: "/login?error=unauthorized",
        failureMessage: true,
      })(req, res, next);
    },
    (_req: Request, res: Response) => {
      res.redirect("/");
    },
  );

  app.get("/api/auth/me", (req: Request, res: Response) => {
    (async () => {
      res.setHeader("Cache-Control", "no-store");
      if (!req.user) {
        const devUser = await getDevUser();
        if (devUser) {
          req.user = devUser;
        }
      }
      if (!req.user) {
        return res.status(401).json({ message: "Not authenticated." });
      }
      const unitRows = await db
        .select({ unitId: userUnits.unitId })
        .from(userUnits)
        .where(eq(userUnits.userId, req.user.id));
      const unitIds = unitRows.map((row) => row.unitId);
      const scopedUnits =
        unitIds.length > 0
          ? await db.select().from(units).where(inArray(units.id, unitIds))
          : [];
      res.json({ user: req.user, unitIds, units: scopedUnits });
    })().catch((error) => {
      console.error("auth/me error", error);
      res.status(500).json({ message: "Failed to load user context." });
    });
  });

  app.post("/api/auth/logout", (req: Request, res: Response, next: NextFunction) => {
    const actorUserId = req.user?.id || null;
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        void logAudit({
          actorUserId,
          action: "auth.logout",
          entityType: "auth_session",
          entityId: null,
          ip: req.ip,
        });
        res.json({ ok: true });
      });
    });
  });
}
