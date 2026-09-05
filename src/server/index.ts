import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { z } from "zod";
import { createApi } from "./api";
import { PostreeveService } from "./core/postreeve";
import { Store } from "./db/store";
import { GoogleOAuth } from "./google/oauth";
import { GmailMailClient } from "./mail/gmail";
import { ImapMailProvider } from "./mail/imap";
import { MailProviderRegistry } from "./mail/provider";
import { MailSenderRegistry } from "./mail/sender";
import { SmtpMailSender } from "./mail/smtp";
import { CredentialVault } from "./security/credentials";
import { desktopApiAuthentication } from "./security/desktop-auth";
import { postreeveSecureHeaders } from "./security/headers";

const store = new Store();
const providers = new MailProviderRegistry();
const senders = new MailSenderRegistry();
const vault = new CredentialVault();
const googleClientId = process.env.POSTREEVE_GOOGLE_CLIENT_ID?.trim() ?? "";
const googleClientSecret = process.env.POSTREEVE_GOOGLE_CLIENT_SECRET?.trim() ?? "";

const serverConfig = z.object({
  hostname: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535),
}).parse({
  hostname: process.env.POSTREEVE_HOST ?? "127.0.0.1",
  port: process.env.PORT ?? "3000",
});
const googleOAuth = googleClientId && googleClientSecret
  ? new GoogleOAuth(
      googleClientId,
      `http://127.0.0.1:${serverConfig.port}/api/oauth/google/callback`,
      fetch,
      googleClientSecret,
    )
  : undefined;

const service = new PostreeveService(
  store,
  { tenantId: "local" },
  providers,
  senders,
  vault,
  (accountId, credentials) => new ImapMailProvider({ accountId, ...credentials }),
  (account, credentials) => {
    if (!credentials.smtp) {
      return {
        verifyConnection: async () => {
          throw new Error("This existing account has no SMTP configuration; add it again with outgoing-mail settings");
        },
        send: async () => {
          throw new Error("This existing account has no SMTP configuration; add it again with outgoing-mail settings");
        },
      };
    }
    return new SmtpMailSender({
      accountId: account.id,
      fromName: account.name,
      fromAddress: account.email,
      ...credentials.smtp,
    });
  },
  (account, credentials) => {
    if (!googleClientId || !googleClientSecret) {
      throw new Error("Set the Google OAuth client ID and secret before using Google accounts");
    }
    const client = new GmailMailClient({
      account,
      credentials,
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    });
    return { provider: client, sender: client };
  },
);
await service.initialize();

const app = new Hono();
app.use("*", postreeveSecureHeaders);
app.use("/api/*", desktopApiAuthentication(process.env.POSTREEVE_DESKTOP_TOKEN));
app.route("/", createApi(service, googleOAuth, {
  oauthReturnUrl: process.env.POSTREEVE_DESKTOP_URL,
}));
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

const server = Bun.serve({ ...serverConfig, fetch: app.fetch });
console.info(`Postreeve listening on http://${server.hostname}:${server.port}`);

export default server;
