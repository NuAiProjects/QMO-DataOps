import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { Strategy as GoogleOIDCStrategy } from "passport-google-oidc";
import { Issuer, Strategy as OpenIDConnectStrategy } from "openid-client";
import { eq, ilike, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "./db";
import { getDevUser } from "./dev-auth";
import { authIdentities, units, userUnits, users } from "@shared/schema";

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required.");
}

const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5000";

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

  app.set("trust proxy", 1);
  app.use(
    session({
      store: new PgStore({
        pool,
        tableName: "session",
        createTableIfMissing: true,
      }),
      secret: SESSION_SECRET,
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
        async (_issuer, profile, done) => {
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
      ),
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
          async (tokenSet, userinfo, done) => {
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

  const simpleAuthPassword = process.env.SIMPLE_AUTH_PASSWORD;

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

    if (!simpleAuthPassword) {
      return res.status(503).json({
        message: "Simple authentication is not configured on the server.",
      });
    }

    const username = parsed.data.username.toLowerCase();
    const user = await findUserByUsername(username);
    if (!user || !user.isActive) {
      return res.status(401).json({
        message: "Invalid username or password.",
      });
    }

    const submittedPassword = parsed.data.password.trim();
    const configuredPassword = simpleAuthPassword.trim();
    const isStrictPasswordCheck = process.env.SIMPLE_AUTH_STRICT === "true";
    if (submittedPassword !== configuredPassword && isStrictPasswordCheck) {
      return res.status(401).json({
        message: "Invalid username or password.",
      });
    }

    req.login(user, (err) => {
      if (err) return next(err);
      return res.json({ ok: true });
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
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
        res.json({ ok: true });
      });
    });
  });
}
