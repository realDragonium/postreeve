import { defaultRetentionPolicy } from "../shared/synchronization";
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_MAX_MESSAGE_BYTES } from "./mail/outgoing-content";
import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { z } from "zod";
import { createApi } from "./api";
import { PostreeveService } from "./core/postreeve";
import { Store } from "./db/store";
import { GoogleOAuth, googleRedirectUri } from "./google/oauth";
import { GmailMailClient } from "./mail/gmail";
import { ImapMailProvider } from "./mail/imap";
import { MailProviderRegistry } from "./mail/provider";
import { MailSendPreDispatchError, MailSenderRegistry } from "./mail/sender";
import { SmtpMailSender } from "./mail/smtp";
import { CredentialVault } from "./security/credentials";
import { desktopApiAuthentication } from "./security/desktop-auth";
import { postreeveSecureHeaders } from "./security/headers";
import { allowedHostGuard, sameOriginGuard } from "./security/request-origin";
import { backupPolicyFromEnvironment, scheduleBackups } from "./runtime/backup";
import { funnelPathGuard } from "./runtime/funnel-paths";
import { createShutdown } from "./runtime/shutdown";

const databasePath = process.env.POSTREEVE_DB_PATH ?? "./data/postreeve.sqlite";
const backupPolicy = backupPolicyFromEnvironment(process.env);
const store = new Store(databasePath);
const providers = new MailProviderRegistry();
const senders = new MailSenderRegistry();
const vault = new CredentialVault();
const googleClientId = process.env.POSTREEVE_GOOGLE_CLIENT_ID?.trim() ?? "";
const googleClientSecret = process.env.POSTREEVE_GOOGLE_CLIENT_SECRET?.trim() ?? "";

const serverConfig = z.object({
  retentionDays: z.coerce.number().int().min(1).max(3650),
  retentionBytes: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostname: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  maxAttachmentBytes: z.coerce.number().int().positive(),
  maxUploadBytes: z.coerce.number().int().positive(),
  maxMessageBytes: z.coerce.number().int().positive(),
  shutdownTimeoutMs: z.coerce.number().int().min(0).max(300_000),
}).parse({
  retentionDays: process.env.POSTREEVE_CONTENT_RETENTION_DAYS ?? defaultRetentionPolicy.maxAgeDays,
  retentionBytes: process.env.POSTREEVE_CONTENT_RETENTION_BYTES ?? defaultRetentionPolicy.maxContentBytes,
  maxUploadBytes: process.env.POSTREEVE_MAX_UPLOAD_BYTES ?? String(DEFAULT_MAX_UPLOAD_BYTES),
  maxMessageBytes: process.env.POSTREEVE_MAX_MESSAGE_BYTES ?? String(DEFAULT_MAX_MESSAGE_BYTES),
  hostname: process.env.POSTREEVE_HOST ?? "127.0.0.1",
  port: process.env.PORT ?? "3000",
  maxAttachmentBytes: process.env.POSTREEVE_MAX_ATTACHMENT_BYTES ?? String(25 * 1024 * 1024),
  shutdownTimeoutMs: process.env.POSTREEVE_SHUTDOWN_TIMEOUT_MS ?? "20000",
});
const googleOAuth = googleClientId && googleClientSecret
  ? new GoogleOAuth(
      googleClientId,
      googleRedirectUri(process.env, serverConfig.port),
      fetch,
      googleClientSecret,
    )
  : undefined;

const service = new PostreeveService(
  store,
  { tenantId: "local", maxAttachmentBytes: serverConfig.maxAttachmentBytes,
    synchronization: { retention: { maxAgeDays: serverConfig.retentionDays, maxContentBytes: serverConfig.retentionBytes } },
    maxUploadBytes: serverConfig.maxUploadBytes, maxMessageBytes: serverConfig.maxMessageBytes },
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
          throw new MailSendPreDispatchError(
            "This existing account has no SMTP configuration; add it again with outgoing-mail settings",
          );
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
await service.recoverInterruptedDraftSends();
await service.initialize();
service.synchronization.start();

const desktopToken = process.env.POSTREEVE_DESKTOP_TOKEN;
const shutdownController = new AbortController();
const app = new Hono();
app.use("*", postreeveSecureHeaders);
// Requests from the public internet through Tailscale Funnel may reach only the remote MCP and OAuth paths.
app.use("*", funnelPathGuard());
app.use("*", allowedHostGuard(serverConfig.hostname));
// With a desktop token every API write is already authenticated, and the protocol proxy forwards a postreeve:// Origin.
if (!desktopToken?.trim()) app.use("/api/*", sameOriginGuard());
app.use("/api/*", desktopApiAuthentication(desktopToken));
app.route("/", createApi(service, googleOAuth, {
  oauthReturnUrl: process.env.POSTREEVE_DESKTOP_URL,
  shutdownSignal: shutdownController.signal,
}));
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

// The mailbox event stream sends a keep-alive every 15 seconds, so idle connections must outlive that.
const server = Bun.serve({ hostname: serverConfig.hostname, port: serverConfig.port, idleTimeout: 60, fetch: app.fetch });
console.info(`Postreeve listening on http://${server.hostname}:${server.port}`);
const stopBackups = backupPolicy ? scheduleBackups(databasePath, backupPolicy, message => console.info(message)) : () => undefined;

const shutdown = createShutdown({
  server,
  endStreams: () => shutdownController.abort(),
  stopSynchronization: () => service.synchronization.stop(),
  closeStore: () => { stopBackups(); store.close(); },
  drainTimeoutMs: serverConfig.shutdownTimeoutMs,
  log: message => console.info(message),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0), (error: unknown) => {
      console.error("Postreeve shutdown failed", error);
      process.exit(1);
    });
  });
}

export default server;
