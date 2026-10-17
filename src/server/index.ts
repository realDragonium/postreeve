import { defaultRetentionPolicy } from "../shared/synchronization";
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_MAX_MESSAGE_BYTES } from "./mail/outgoing-content";
import { z } from "zod";
import { createServerApp } from "./app";
import { PostreeveService } from "./core/postreeve";
import { Store } from "./db/store";
import { GoogleOAuth, googleRedirectUri } from "./google/oauth";
import { GmailMailClient } from "./mail/gmail";
import { ImapMailProvider } from "./mail/imap";
import { MailProviderRegistry } from "./mail/provider";
import { MailSendPreDispatchError, MailSenderRegistry } from "./mail/sender";
import { SmtpMailSender } from "./mail/smtp";
import { CredentialVault } from "./security/credentials";
import { OwnerAuth } from "./security/owner-auth";
import { parsePublicUrl, parseTrustProxy } from "./security/request-context";
import { backupPolicyFromEnvironment, scheduleBackups } from "./runtime/backup";
import { createPublicApp, publicListenerFromEnvironment } from "./runtime/public-listener";
import { createShutdown } from "./runtime/shutdown";
import { defaultDnsLookup } from "./stalwart/dns";
import { MailServerAdmin } from "./stalwart/service";
import { DnsProviders } from "./dns-providers/service";

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
const publicListener = publicListenerFromEnvironment(process.env);
const desktopToken = process.env.POSTREEVE_DESKTOP_TOKEN;
const auth = new OwnerAuth({
  store: store.owner,
  trust: {
    publicUrl: parsePublicUrl(process.env.POSTREEVE_PUBLIC_URL),
    trustProxy: parseTrustProxy(process.env.POSTREEVE_TRUST_PROXY),
  },
  setupToken: process.env.POSTREEVE_SETUP_TOKEN,
  desktopToken,
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

const shutdownController = new AbortController();
const mailServers = new MailServerAdmin({ store: store.mailServers, vault, accounts: service, dns: defaultDnsLookup() });
const dnsProviders = new DnsProviders({ store: store.dnsProviders, vault, records: mailServers });
mailServers.setDnsApplier(async (serverId, domainId) => {
  const { results } = await dnsProviders.applyDefaults(serverId, domainId);
  const failed = results.filter(({ ok }) => !ok);
  if (failed.length) throw new Error(`${failed.length} of ${results.length} DNS changes failed: ${failed.map(({ message }) => message).join("; ")}`);
  return `Published ${results.length} DNS change${results.length === 1 ? "" : "s"}`;
});
const agentAccess = {
  service, store: store.agentAccess, mailServers, publicUrl: process.env.POSTREEVE_PUBLIC_URL, mcpPublicUrl: process.env.POSTREEVE_MCP_PUBLIC_URL,
};
const app = createServerApp({
  service,
  auth,
  hostname: serverConfig.hostname,
  googleOAuth,
  desktopToken,
  api: { oauthReturnUrl: process.env.POSTREEVE_DESKTOP_URL, shutdownSignal: shutdownController.signal },
  agentAccess,
  mailServers,
  dnsProviders,
  staticRoot: "./dist",
});

// The mailbox event stream sends a keep-alive every 15 seconds, so idle connections must outlive that.
const server = Bun.serve({ hostname: serverConfig.hostname, port: serverConfig.port, idleTimeout: 60, fetch: app.fetch });
console.info(`Postreeve listening on http://${server.hostname}:${server.port}`);
const setupToken = auth.desktop ? null : auth.setupTokenToLog();
if (setupToken) console.info(`Postreeve has no owner yet. Setup token for this run: ${setupToken}`);
// The public listener serves only the remote MCP and OAuth allowlist; Caddy publishes it at POSTREEVE_MCP_PUBLIC_URL.
const publicServer = publicListener
  ? Bun.serve({ hostname: serverConfig.hostname, port: publicListener.port, idleTimeout: 60, fetch: createPublicApp(publicListener, agentAccess).fetch })
  : null;
if (publicServer) console.info(`Postreeve agent endpoints listening on http://${publicServer.hostname}:${publicServer.port} for ${publicListener!.url.origin}`);
const stopBackups = backupPolicy ? scheduleBackups(databasePath, backupPolicy, message => console.info(message)) : () => undefined;

const shutdown = createShutdown({
  server: { stop: async (closeActiveConnections) => { await Promise.all([server.stop(closeActiveConnections), publicServer?.stop(closeActiveConnections)]); } },
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
