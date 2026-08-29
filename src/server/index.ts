import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { createApi } from "./api";
import { PostreeveService } from "./core/postreeve";
import { Store } from "./db/store";
import { FixtureMailSender } from "./mail/fixture-sender";
import { ImapMailProvider } from "./mail/imap";
import { MailProviderRegistry } from "./mail/provider";
import { MailSenderRegistry } from "./mail/sender";
import { SmtpMailSender } from "./mail/smtp";
import { CredentialVault } from "./security/credentials";

const store = new Store();
const providers = new MailProviderRegistry();
const senders = new MailSenderRegistry();
const vault = new CredentialVault();

const service = new PostreeveService(
  store,
  providers,
  senders,
  vault,
  (accountId, credentials) => new ImapMailProvider({ accountId, ...credentials }),
  (account, credentials, fixtureProvider) => {
    if (fixtureProvider) {
      return new FixtureMailSender({
        accountId: account.id,
        fromName: account.name,
        fromAddress: account.email,
      }, ({ input, receipt }) => {
        fixtureProvider.appendSent(input, receipt.messageId, receipt.submittedAt);
      });
    }
    if (!credentials?.smtp) {
      return {
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
);
await service.initialize();

const app = new Hono();
app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"],
    connectSrc: ["'self'"],
    frameSrc: ["'none'"],
  },
  referrerPolicy: "no-referrer",
}));
app.route("/", createApi(service));
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

const serverConfig = z.object({
  hostname: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535),
}).parse({
  hostname: process.env.POSTREEVE_HOST ?? "127.0.0.1",
  port: process.env.PORT ?? "3000",
});

console.info(`Postreeve listening on http://${serverConfig.hostname}:${serverConfig.port}`);

export default { ...serverConfig, fetch: app.fetch };
