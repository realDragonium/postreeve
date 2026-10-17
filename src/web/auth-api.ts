import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { ZodType } from "zod";
import { z } from "zod";

/** Fired when any API call answers 401 `unauthenticated`, so the auth gate can show sign-in again. */
export const UNAUTHENTICATED_EVENT = "postreeve:unauthenticated";

export function notifyUnauthenticated(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
}

const ownerSessionSchema = z.object({
  id: z.string(),
  method: z.enum(["password", "passkey", "desktop"]),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
});

export const authStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("setup"), passkeys: z.boolean() }),
  z.object({ state: z.literal("login"), passkeys: z.boolean(), hasPasskeys: z.boolean() }),
  z.object({ state: z.literal("authenticated"), passkeys: z.boolean(), desktop: z.boolean(), session: ownerSessionSchema }),
]);

export const passkeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  backedUp: z.boolean(),
});

export const sessionSummarySchema = ownerSessionSchema.extend({
  userAgent: z.string(),
  current: z.boolean(),
});

export type AuthState = z.infer<typeof authStateSchema>;
export type Passkey = z.infer<typeof passkeySchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export class AuthRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AuthRequestError";
  }
}

const okSchema = z.object({ ok: z.literal(true) });
const sessionResultSchema = z.object({ session: ownerSessionSchema });

async function authRequest<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${response.status})`;
    if (response.status === 401 && typeof body === "object" && body !== null && "code" in body && body.code === "unauthenticated") {
      notifyUnauthenticated();
    }
    throw new AuthRequestError(message, response.status);
  }
  return schema.parse(body);
}

function post(value: unknown = {}): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

/** WebAuthn options pass through untouched; the browser library validates their shape. */
const creationOptionsSchema = z.custom<PublicKeyCredentialCreationOptionsJSON>((value) => typeof value === "object" && value !== null);
const requestOptionsSchema = z.custom<PublicKeyCredentialRequestOptionsJSON>((value) => typeof value === "object" && value !== null);

export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) return error.message;
  if (error instanceof Error && error.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
  if (error instanceof Error && error.name === "InvalidStateError") return "This passkey is already registered.";
  return error instanceof Error ? error.message : "Passkey request failed";
}

export const authApi = {
  state: () => authRequest("/session", authStateSchema),
  setup: (setupToken: string, password: string) => authRequest("/setup", sessionResultSchema, post({ setupToken, password })),
  loginWithPassword: (password: string) => authRequest("/login/password", sessionResultSchema, post({ password })),
  async loginWithPasskey() {
    const optionsJSON = await authRequest("/login/passkey/options", requestOptionsSchema, post());
    const response = await startAuthentication({ optionsJSON });
    return authRequest("/login/passkey/verify", sessionResultSchema, post({ response }));
  },
  logout: () => authRequest("/logout", okSchema, post()),
  passkeys: () => authRequest("/passkeys", passkeySchema.array()),
  async addPasskey(name: string) {
    const optionsJSON = await authRequest("/passkeys/options", creationOptionsSchema, post());
    const response = await startRegistration({ optionsJSON });
    return authRequest("/passkeys", passkeySchema, post({ name, response }));
  },
  removePasskey: (id: string) => authRequest(`/passkeys/${encodeURIComponent(id)}`, okSchema, { method: "DELETE" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    authRequest("/password", okSchema, post({ currentPassword, newPassword })),
  sessions: () => authRequest("/sessions", sessionSummarySchema.array()),
  revokeSession: (id: string) => authRequest(`/sessions/${encodeURIComponent(id)}`, okSchema, { method: "DELETE" }),
  revokeOtherSessions: () => authRequest("/sessions/revoke-others", z.object({ revoked: z.number() }), post()),
};
