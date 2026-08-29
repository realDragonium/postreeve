import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const SESSION_TTL_MS = 10 * 60 * 1000;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});
const profileSchema = z.object({ emailAddress: z.string().email() });

export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface PendingSession {
  verifier: string;
  createdAt: number;
}

export interface GoogleOAuthResult {
  email: string;
  refreshToken: string;
}

export class GoogleOAuth {
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #clientSecret: string | undefined;
  readonly #fetch: OAuthFetch;
  readonly #pending = new Map<string, PendingSession>();

  constructor(clientId: string, redirectUri: string, request: OAuthFetch = fetch, clientSecret?: string) {
    this.#clientId = z.string().min(1).parse(clientId);
    this.#redirectUri = z.url().parse(redirectUri);
    this.#fetch = request;
    this.#clientSecret = clientSecret ? z.string().min(1).parse(clientSecret) : undefined;
  }

  start(): string {
    this.#removeExpired();
    const state = randomToken(32);
    const verifier = randomToken(64);
    this.#pending.set(state, { verifier, createdAt: Date.now() });
    const params = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: toBase64Url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  }

  async complete(callbackUrl: string): Promise<GoogleOAuthResult> {
    this.#removeExpired();
    const url = new URL(callbackUrl);
    const error = url.searchParams.get("error");
    if (error) throw new Error("Google authorization was cancelled or denied");
    const state = url.searchParams.get("state") ?? "";
    const session = this.#pending.get(state);
    this.#pending.delete(state);
    if (!session) throw new Error("Google authorization session is missing or expired");
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Google did not return an authorization code");

    const tokenRequest = new URLSearchParams({
      client_id: this.#clientId,
      code,
      code_verifier: session.verifier,
      grant_type: "authorization_code",
      redirect_uri: this.#redirectUri,
    });
    if (this.#clientSecret) tokenRequest.set("client_secret", this.#clientSecret);
    const response = await this.#fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenRequest,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = z.object({
        error: z.string().max(100),
        error_description: z.string().max(200).optional(),
      }).safeParse(body);
      const detail = reason.success
        ? `: ${reason.data.error}${reason.data.error_description ? ` (${reason.data.error_description})` : ""}`
        : "";
      throw new Error(`Google token exchange failed (${response.status}${detail})`);
    }
    const token = tokenSchema.safeParse(body);
    if (!token.success) throw new Error("Google did not return a usable access and refresh token");
    const profileResponse = await this.#fetch(PROFILE_ENDPOINT, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token.data.access_token}` },
    });
    const profileBody: unknown = await profileResponse.json().catch(() => null);
    if (!profileResponse.ok) throw new Error("Google authorized the account but its Gmail profile could not be read");
    const profile = profileSchema.safeParse(profileBody);
    if (!profile.success) throw new Error("Google returned an invalid Gmail profile");
    return { email: profile.data.emailAddress, refreshToken: token.data.refresh_token };
  }

  #removeExpired(): void {
    const expiredBefore = Date.now() - SESSION_TTL_MS;
    for (const [state, session] of this.#pending) {
      if (session.createdAt < expiredBefore) this.#pending.delete(state);
    }
  }
}

function randomToken(bytes: number): string {
  return toBase64Url(randomBytes(bytes));
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
