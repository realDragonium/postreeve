import { zValidator } from "@hono/zod-validator";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { OwnerStore, StoredPasskey, StoredSession } from "./owner-store";
import {
  clientKey,
  isSecureRequest,
  relyingParty,
  untrustedNetwork,
  type RelyingParty,
  type RequestTrust,
} from "./request-context";

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const SETUP_TOKEN_MIN_LENGTH = 16;
export const CLIENT_FAILURE_LIMIT = 5;
export const GLOBAL_FAILURE_LIMIT = 50;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 100;
const MAX_PASSKEYS = 20;
const SECURE_COOKIE = "__Host-postreeve-session";
const PLAIN_COOKIE = "postreeve-session";
const DESKTOP_SESSION_ID = "desktop";

export interface OwnerSession {
  readonly id: string;
  readonly method: "password" | "passkey" | "desktop";
  readonly createdAt: string;
  readonly lastSeenAt: string;
  /** Absolute expiry; the session also ends after SESSION_IDLE_MS without use. */
  readonly expiresAt: string;
}

declare module "hono" {
  interface ContextVariableMap {
    ownerAuth: OwnerAuth;
    ownerSession: OwnerSession | null;
  }
}

export class AuthError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "AuthError";
  }
}

export interface OwnerAuthOptions {
  readonly store: OwnerStore;
  readonly trust?: RequestTrust | undefined;
  /** `POSTREEVE_SETUP_TOKEN`; when blank, a token is generated for this process. */
  readonly setupToken?: string | undefined;
  /** `POSTREEVE_DESKTOP_TOKEN`; a request bearing it is the desktop app's owner session. */
  readonly desktopToken?: string | undefined;
  readonly now?: () => Date;
  /** Lower argon2id cost for tests only. */
  readonly passwordCost?: { readonly memoryCost: number; readonly timeCost: number };
}

/** Sliding-window failure counter kept in memory; a restart clears it. */
class FailureLimiter {
  readonly #failures = new Map<string, number[]>();

  constructor(readonly limit: number, readonly windowMs: number, readonly maxKeys = 10_000) {}

  /** Seconds until the key may try again, or null when it is not blocked. */
  retryAfter(key: string, now: number): number | null {
    const recent = this.#recent(key, now);
    if (recent.length < this.limit) return null;
    return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
  }

  fail(key: string, now: number): void {
    const recent = this.#recent(key, now);
    recent.push(now);
    this.#failures.delete(key);
    this.#failures.set(key, recent);
    while (this.#failures.size > this.maxKeys) {
      const oldest = this.#failures.keys().next().value;
      if (oldest === undefined) break;
      this.#failures.delete(oldest);
    }
  }

  clear(key: string): void {
    this.#failures.delete(key);
  }

  #recent(key: string, now: number): number[] {
    return (this.#failures.get(key) ?? []).filter((at) => at > now - this.windowMs);
  }
}

interface PendingChallenge {
  readonly purpose: "registration" | "authentication";
  readonly rpId: string;
  readonly expiresAt: number;
}

/** Single-use WebAuthn challenges; capped so unauthenticated option requests cannot grow memory. */
class ChallengeStore {
  readonly #pending = new Map<string, PendingChallenge>();

  issue(challenge: string, purpose: PendingChallenge["purpose"], rpId: string, now: number): void {
    for (const [key, value] of this.#pending) if (value.expiresAt <= now) this.#pending.delete(key);
    while (this.#pending.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(challenge, { purpose, rpId, expiresAt: now + CHALLENGE_TTL_MS });
  }

  consume(challenge: string, purpose: PendingChallenge["purpose"], rpId: string, now: number): boolean {
    const pending = this.#pending.get(challenge);
    this.#pending.delete(challenge);
    return pending !== undefined && pending.purpose === purpose && pending.rpId === rpId && pending.expiresAt > now;
  }
}

export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly backedUp: boolean;
}

export interface SessionSummary extends OwnerSession {
  readonly userAgent: string;
  readonly current: boolean;
}

export type AuthState =
  | { readonly state: "setup"; readonly passkeys: boolean }
  | { readonly state: "login"; readonly passkeys: boolean; readonly hasPasskeys: boolean }
  | { readonly state: "authenticated"; readonly passkeys: boolean; readonly desktop: boolean; readonly session: OwnerSession };

export class OwnerAuth {
  readonly store: OwnerStore;
  readonly trust: RequestTrust;
  readonly desktop: boolean;
  readonly #desktopAuthorization: string | null;
  readonly #setupTokenDigest: Buffer;
  readonly #generatedSetupToken: string | null;
  readonly #now: () => Date;
  readonly #passwordCost: OwnerAuthOptions["passwordCost"];
  readonly #clientFailures = new FailureLimiter(CLIENT_FAILURE_LIMIT, FAILURE_WINDOW_MS);
  readonly #globalFailures = new FailureLimiter(GLOBAL_FAILURE_LIMIT, FAILURE_WINDOW_MS);
  readonly #challenges = new ChallengeStore();
  readonly #startedAt: string;
  #lastCleanup = 0;

  constructor(options: OwnerAuthOptions) {
    this.store = options.store;
    this.trust = options.trust ?? untrustedNetwork;
    this.#now = options.now ?? (() => new Date());
    this.#passwordCost = options.passwordCost;
    const desktopToken = options.desktopToken?.trim();
    this.desktop = Boolean(desktopToken);
    this.#desktopAuthorization = desktopToken ? `Bearer ${desktopToken}` : null;
    const configured = options.setupToken?.trim();
    if (configured && configured.length < SETUP_TOKEN_MIN_LENGTH) {
      throw new Error(`POSTREEVE_SETUP_TOKEN must be at least ${SETUP_TOKEN_MIN_LENGTH} characters`);
    }
    this.#generatedSetupToken = configured ? null : randomBytes(24).toString("base64url");
    this.#setupTokenDigest = sha256(configured || this.#generatedSetupToken!);
    this.#startedAt = this.#now().toISOString();
  }

  /** The generated setup token to print at startup; null once an owner exists or when the token came from the environment. */
  setupTokenToLog(): string | null {
    return this.store.getOwner() ? null : this.#generatedSetupToken;
  }

  state(context: Context): AuthState {
    const passkeys = relyingParty(context, this.trust) !== null;
    const session = this.session(context);
    if (session) return { state: "authenticated", passkeys, desktop: session.method === "desktop", session };
    if (!this.store.getOwner()) return { state: "setup", passkeys };
    return { state: "login", passkeys, hasPasskeys: this.store.listPasskeys().length > 0 };
  }

  /** The request's owner session, looked up once per request. */
  session(context: Context): OwnerSession | null {
    const cached = context.get("ownerSession");
    if (cached !== undefined) return cached;
    const session = this.#lookup(context);
    context.set("ownerSession", session);
    return session;
  }

  /** Whether the session this request authenticated with still exists, without extending it; long-lived streams poll this. */
  sessionStillActive(context: Context): boolean {
    const session = context.get("ownerSession");
    if (!session) return false;
    if (session.method === "desktop") return true;
    const row = this.store.getSession(session.id);
    return row !== null && !this.#expired(row, this.#ms());
  }

  async setup(context: Context, setupToken: string, password: string): Promise<OwnerSession> {
    if (this.store.getOwner()) throw new AuthError(409, "Postreeve already has an owner");
    const key = clientKey(context, this.trust);
    this.#assertNotLimited(key, true);
    if (!timingSafeEqual(sha256(setupToken.trim()), this.#setupTokenDigest)) {
      this.#recordFailure(key, true);
      throw new AuthError(403, "Incorrect setup token");
    }
    assertPasswordLength(password);
    const hash = await this.#hashPassword(password);
    if (!this.store.createOwner(hash, randomBytes(32).toString("base64url"), this.#iso())) {
      throw new AuthError(409, "Postreeve already has an owner");
    }
    this.#clientFailures.clear(key);
    return this.#startSession(context, "password");
  }

  async loginWithPassword(context: Context, password: string): Promise<OwnerSession> {
    const key = clientKey(context, this.trust);
    this.#assertNotLimited(key, true);
    const owner = this.store.getOwner();
    const valid = owner !== null && await Bun.password.verify(password, owner.passwordHash);
    if (!valid) {
      this.#recordFailure(key, true);
      throw new AuthError(401, "Incorrect password");
    }
    this.#clientFailures.clear(key);
    return this.#startSession(context, "password");
  }

  async authenticationOptions(context: Context) {
    const rp = this.#requireRelyingParty(context);
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      allowCredentials: this.store.listPasskeys().map(credentialDescriptor),
      userVerification: "preferred",
    });
    this.#challenges.issue(options.challenge, "authentication", rp.id, this.#ms());
    return options;
  }

  async loginWithPasskey(context: Context, response: AuthenticationResponseJSON): Promise<OwnerSession> {
    const key = clientKey(context, this.trust);
    this.#assertNotLimited(key, false);
    const rp = this.#requireRelyingParty(context);
    const passkey = typeof response.id === "string" ? this.store.getPasskey(response.id) : null;
    let verified = false;
    let newCounter = 0;
    if (passkey) {
      try {
        const result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: (challenge) => this.#challenges.consume(challenge, "authentication", rp.id, this.#ms()),
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          credential: {
            id: passkey.id,
            publicKey: new Uint8Array(passkey.publicKey),
            counter: passkey.counter,
            transports: passkey.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: false,
        });
        verified = result.verified;
        newCounter = result.authenticationInfo.newCounter;
      } catch {
        verified = false;
      }
    }
    if (!passkey || !verified) {
      this.#recordFailure(key, false);
      throw new AuthError(401, "Passkey sign-in failed");
    }
    this.store.recordPasskeyUse(passkey.id, newCounter, this.#iso());
    this.#clientFailures.clear(key);
    return this.#startSession(context, "passkey");
  }

  async registrationOptions(context: Context) {
    const rp = this.#requireRelyingParty(context);
    const owner = this.store.getOwner();
    if (!owner) throw new AuthError(409, "Set up Postreeve before adding a passkey");
    const passkeys = this.store.listPasskeys();
    if (passkeys.length >= MAX_PASSKEYS) throw new AuthError(400, `Postreeve keeps at most ${MAX_PASSKEYS} passkeys`);
    const options = await generateRegistrationOptions({
      rpName: "Postreeve",
      rpID: rp.id,
      userName: "owner",
      userDisplayName: "Postreeve owner",
      userID: new Uint8Array(Buffer.from(owner.webauthnUserId, "base64url")),
      attestationType: "none",
      excludeCredentials: passkeys.map(credentialDescriptor),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    this.#challenges.issue(options.challenge, "registration", rp.id, this.#ms());
    return options;
  }

  async registerPasskey(context: Context, name: string, response: RegistrationResponseJSON): Promise<PasskeySummary> {
    const rp = this.#requireRelyingParty(context);
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: (challenge) => this.#challenges.consume(challenge, "registration", rp.id, this.#ms()),
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
      });
    } catch {
      throw new AuthError(400, "Passkey registration failed");
    }
    if (!result.verified || !result.registrationInfo) throw new AuthError(400, "Passkey registration failed");
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    if (this.store.getPasskey(credential.id)) throw new AuthError(409, "This passkey is already registered");
    const passkey: StoredPasskey = {
      id: credential.id,
      name,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: this.#iso(),
      lastUsedAt: null,
    };
    this.store.addPasskey(passkey);
    return passkeySummary(passkey);
  }

  listPasskeys(): PasskeySummary[] {
    return this.store.listPasskeys().map(passkeySummary);
  }

  removePasskey(id: string): void {
    if (!this.store.removePasskey(id)) throw new AuthError(404, "Passkey not found");
  }

  async changePassword(context: Context, currentPassword: string, newPassword: string): Promise<void> {
    const session = this.#requireSession(context);
    const key = clientKey(context, this.trust);
    this.#assertNotLimited(key, false);
    const owner = this.store.getOwner();
    if (!owner || !await Bun.password.verify(currentPassword, owner.passwordHash)) {
      this.#recordFailure(key, false);
      throw new AuthError(401, "Incorrect current password");
    }
    assertPasswordLength(newPassword);
    this.store.setPasswordHash(await this.#hashPassword(newPassword), this.#iso());
    this.store.deleteSessionsExcept(session.id);
  }

  listSessions(context: Context): SessionSummary[] {
    const current = this.session(context);
    const now = this.#ms();
    return this.store.listSessions()
      .filter((row) => !this.#expired(row, now))
      .map((row) => ({ ...ownerSession(row), userAgent: row.userAgent, current: row.id === current?.id }));
  }

  revokeSession(context: Context, id: string): void {
    const current = this.#requireSession(context);
    if (!this.store.deleteSession(id)) throw new AuthError(404, "Session not found");
    if (id === current.id) this.#clearCookie(context);
  }

  revokeOtherSessions(context: Context): number {
    return this.store.deleteSessionsExcept(this.#requireSession(context).id);
  }

  logout(context: Context): void {
    const session = this.session(context);
    if (session && session.method !== "desktop") this.store.deleteSession(session.id);
    this.#clearCookie(context);
  }

  #lookup(context: Context): OwnerSession | null {
    if (this.#desktopAuthorization) {
      return context.req.header("Authorization") === this.#desktopAuthorization
        ? { id: DESKTOP_SESSION_ID, method: "desktop", createdAt: this.#startedAt, lastSeenAt: this.#iso(), expiresAt: this.#startedAt }
        : null;
    }
    const token = getCookie(context, cookieName(isSecureRequest(context, this.trust)));
    if (!token || token.length > 128) return null;
    const row = this.store.findSessionByTokenHash(sha256(token).toString("hex"));
    if (!row) return null;
    const now = this.#ms();
    this.#cleanup(now);
    if (this.#expired(row, now)) {
      this.store.deleteSession(row.id);
      return null;
    }
    if (now - Date.parse(row.lastSeenAt) >= SESSION_TOUCH_INTERVAL_MS) {
      const lastSeenAt = new Date(now).toISOString();
      this.store.touchSession(row.id, lastSeenAt);
      return ownerSession({ ...row, lastSeenAt });
    }
    return ownerSession(row);
  }

  #expired(row: StoredSession, now: number): boolean {
    return now >= Date.parse(row.expiresAt) || now - Date.parse(row.lastSeenAt) >= SESSION_IDLE_MS;
  }

  #cleanup(now: number): void {
    if (now - this.#lastCleanup < SESSION_CLEANUP_INTERVAL_MS) return;
    this.#lastCleanup = now;
    this.store.deleteExpiredSessions(new Date(now).toISOString(), new Date(now - SESSION_IDLE_MS).toISOString());
  }

  #startSession(context: Context, method: "password" | "passkey"): OwnerSession {
    const token = randomBytes(32).toString("base64url");
    const now = this.#ms();
    const row: StoredSession = {
      id: randomUUID(),
      tokenHash: sha256(token).toString("hex"),
      method,
      userAgent: (context.req.header("User-Agent") ?? "").slice(0, 300),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_ABSOLUTE_MS).toISOString(),
    };
    this.store.createSession(row);
    const secure = isSecureRequest(context, this.trust);
    setCookie(context, cookieName(secure), token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    });
    const session = ownerSession(row);
    context.set("ownerSession", session);
    return session;
  }

  #clearCookie(context: Context): void {
    const secure = isSecureRequest(context, this.trust);
    deleteCookie(context, cookieName(secure), { path: "/", secure, httpOnly: true, sameSite: "Lax" });
    context.set("ownerSession", null);
  }

  #requireSession(context: Context): OwnerSession {
    const session = this.session(context);
    if (!session || session.method === "desktop") throw new AuthError(401, "Authentication required");
    return session;
  }

  #requireRelyingParty(context: Context): RelyingParty {
    const rp = relyingParty(context, this.trust);
    if (!rp) throw new AuthError(400, "Passkeys need http://localhost or the address in POSTREEVE_PUBLIC_URL");
    return rp;
  }

  #assertNotLimited(key: string, countsGlobally: boolean): void {
    const now = this.#ms();
    const client = this.#clientFailures.retryAfter(key, now);
    const global = countsGlobally ? this.#globalFailures.retryAfter("global", now) : null;
    const retryAfter = Math.max(client ?? 0, global ?? 0);
    if (retryAfter > 0) throw new AuthError(429, "Too many failed attempts; try again later", retryAfter);
  }

  #recordFailure(key: string, countsGlobally: boolean): void {
    const now = this.#ms();
    this.#clientFailures.fail(key, now);
    if (countsGlobally) this.#globalFailures.fail("global", now);
  }

  #hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password, { algorithm: "argon2id", ...this.#passwordCost });
  }

  #ms(): number {
    return this.#now().getTime();
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

/** Makes the OwnerAuth instance available to requireOwner and getOwnerSession on every route. */
export function ownerAuthContext(auth: OwnerAuth): MiddlewareHandler {
  return async (context, next) => {
    context.set("ownerAuth", auth);
    return next();
  };
}

/** The current owner session, or null; requires ownerAuthContext earlier in the chain. */
export function getOwnerSession(context: Context): OwnerSession | null {
  const auth = context.get("ownerAuth") as OwnerAuth | undefined;
  return auth ? auth.session(context) : null;
}

export const requireOwner: MiddlewareHandler = async (context, next) => {
  if (!getOwnerSession(context)) {
    return context.json({ error: "Authentication required", code: "unauthenticated" as const }, 401);
  }
  return next();
};

const publicApiPaths = new Set([
  "/api/health",
  "/api/auth/session",
  "/api/auth/setup",
  "/api/auth/logout",
  "/api/auth/login/password",
  "/api/auth/login/passkey/options",
  "/api/auth/login/passkey/verify",
]);

/** Guards every /api route except health and the sign-in endpoints. */
export const ownerApiGuard: MiddlewareHandler = async (context, next) => {
  if (publicApiPaths.has(context.req.path)) return next();
  return requireOwner(context, next);
};

const passwordSchema = z.string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
const webAuthnResponseSchema = z.object({ id: z.string().min(1).max(1024), type: z.literal("public-key") }).passthrough();

function json<T extends z.ZodType>(schema: T) {
  return zValidator("json", schema, (result, context) => {
    if (!result.success) return context.json({ error: result.error.issues[0]?.message ?? "Invalid request" }, 400);
    return undefined;
  });
}

export function createAuthApi(auth: OwnerAuth) {
  return new Hono()
    .basePath("/api/auth")
    .get("/session", (context) => context.json(auth.state(context)))
    .post("/setup", json(z.object({ setupToken: z.string().min(1).max(512), password: passwordSchema })), async (context) => {
      const { setupToken, password } = context.req.valid("json");
      return context.json({ session: await auth.setup(context, setupToken, password) }, 201);
    })
    .post("/login/password", json(z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) })), async (context) =>
      context.json({ session: await auth.loginWithPassword(context, context.req.valid("json").password) }))
    .post("/login/passkey/options", async (context) => context.json(await auth.authenticationOptions(context)))
    .post("/login/passkey/verify", json(z.object({ response: webAuthnResponseSchema })), async (context) =>
      context.json({
        session: await auth.loginWithPasskey(context, context.req.valid("json").response as unknown as AuthenticationResponseJSON),
      }))
    .post("/logout", (context) => {
      auth.logout(context);
      return context.json({ ok: true as const });
    })
    .get("/passkeys", requireOwner, (context) => context.json(auth.listPasskeys()))
    .post("/passkeys/options", requireOwner, async (context) => context.json(await auth.registrationOptions(context)))
    .post("/passkeys", requireOwner, json(z.object({
      name: z.string().trim().min(1, "Name the passkey").max(64, "Passkey names are at most 64 characters"),
      response: webAuthnResponseSchema,
    })), async (context) => {
      const { name, response } = context.req.valid("json");
      return context.json(await auth.registerPasskey(context, name, response as unknown as RegistrationResponseJSON), 201);
    })
    .delete("/passkeys/:id", requireOwner, (context) => {
      auth.removePasskey(context.req.param("id"));
      return context.json({ ok: true as const });
    })
    .post("/password", requireOwner, json(z.object({
      currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
      newPassword: passwordSchema,
    })), async (context) => {
      const { currentPassword, newPassword } = context.req.valid("json");
      await auth.changePassword(context, currentPassword, newPassword);
      return context.json({ ok: true as const });
    })
    .get("/sessions", requireOwner, (context) => context.json(auth.listSessions(context)))
    .delete("/sessions/:id", requireOwner, (context) => {
      auth.revokeSession(context, context.req.param("id"));
      return context.json({ ok: true as const });
    })
    .post("/sessions/revoke-others", requireOwner, (context) =>
      context.json({ revoked: auth.revokeOtherSessions(context) }))
    .onError((error, context) => {
      if (error instanceof AuthError) {
        if (error.retryAfterSeconds) context.header("Retry-After", String(error.retryAfterSeconds));
        return context.json({ error: error.message }, error.status);
      }
      console.error(`Authentication request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return context.json({ error: "Authentication request failed" }, 500);
    });
}

function assertPasswordLength(password: string): void {
  const result = passwordSchema.safeParse(password);
  if (!result.success) throw new AuthError(400, result.error.issues[0]?.message ?? "Invalid password");
}

function cookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE : PLAIN_COOKIE;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function credentialDescriptor(passkey: StoredPasskey) {
  return { id: passkey.id, transports: passkey.transports as AuthenticatorTransportFuture[] };
}

function ownerSession(row: StoredSession): OwnerSession {
  return { id: row.id, method: row.method, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt };
}

function passkeySummary(passkey: StoredPasskey): PasskeySummary {
  return { id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt, backedUp: passkey.backedUp };
}
