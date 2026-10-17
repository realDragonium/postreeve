import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  addDomainInputSchema,
  approveMailServerProposalInputSchema,
  connectMailServerInputSchema,
  createMailServerProposalInputSchema,
  createMailboxInputSchema,
  createMailingListInputSchema,
  mailServerIdSchema,
  spamListNameSchema,
  updateMailServerInputSchema,
  updateMailboxInputSchema,
  updateMailingListInputSchema,
} from "../../shared/mail-server";
import { MailServerError } from "./jmap";
import type { MailServerAdmin } from "./service";

const objectId = z.string().min(1).max(64).regex(/^[a-z0-9]+$/i);
const server = z.object({ serverId: mailServerIdSchema });
const domain = server.extend({ domainId: objectId });
const mailbox = server.extend({ mailboxId: objectId });
const list = server.extend({ listId: objectId });
const key = server.extend({ keyId: objectId });
const queued = server.extend({ messageId: objectId });
const spamList = server.extend({ list: spamListNameSchema });
const spamEntry = spamList.extend({ entryId: objectId });
const proposal = z.object({ proposalId: z.uuid() });
const ok = { ok: true as const };

/**
 * The Mail server admin routes. They sit behind the same origin guard as the rest of `/api`, so only the
 * Postreeve page reaches the approve route; agents get read-only tools and proposal creation instead.
 */
export function createMailServerRoutes(admin: MailServerAdmin) {
  return new Hono()
    .basePath("/api/mail-servers")
    .get("/", async (c) => c.json(await admin.listServers()))
    .post("/", zValidator("json", connectMailServerInputSchema), async (c) => c.json(await admin.connect(c.req.valid("json")), 201))
    .get("/proposals", (c) => c.json(admin.listProposals()))
    .post("/proposals/:proposalId/approve", zValidator("param", proposal), zValidator("json", approveMailServerProposalInputSchema), async (c) =>
      c.json(await admin.approveProposal(c.req.valid("param").proposalId, c.req.valid("json"))))
    .post("/proposals/:proposalId/reject", zValidator("param", proposal), (c) => c.json(admin.rejectProposal(c.req.valid("param").proposalId)))
    .put("/:serverId", zValidator("param", server), zValidator("json", updateMailServerInputSchema), async (c) =>
      c.json(await admin.updateServer(c.req.valid("param").serverId, c.req.valid("json"))))
    .delete("/:serverId", zValidator("param", server), (c) => { admin.disconnect(c.req.valid("param").serverId); return c.json(ok); })
    .post("/:serverId/proposals", zValidator("param", server), zValidator("json", createMailServerProposalInputSchema), (c) =>
      c.json(admin.createProposal(c.req.valid("param").serverId, c.req.valid("json"), "Postreeve page"), 201))
    .get("/:serverId/domains", zValidator("param", server), async (c) => c.json(await admin.domains(c.req.valid("param").serverId)))
    .post("/:serverId/domains", zValidator("param", server), zValidator("json", addDomainInputSchema), async (c) =>
      c.json(await admin.addDomain(c.req.valid("param").serverId, c.req.valid("json").name), 201))
    .delete("/:serverId/domains/:domainId", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      await admin.deleteDomain(serverId, domainId, await c.req.json().catch(() => ({})));
      return c.json(ok);
    })
    .put("/:serverId/domains/:domainId/catch-all", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await admin.setCatchAll(serverId, domainId, await c.req.json()));
    })
    .get("/:serverId/domains/:domainId/dns", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await admin.dnsChecklist(serverId, domainId));
    })
    .get("/:serverId/domains/:domainId/mailboxes", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await admin.mailboxes(serverId, domainId));
    })
    .get("/:serverId/domains/:domainId/lists", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await admin.mailingLists(serverId, domainId));
    })
    .get("/:serverId/domains/:domainId/dkim", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await admin.dkimKeys(serverId, domainId));
    })
    .post("/:serverId/domains/:domainId/dkim", zValidator("param", domain), async (c) => {
      const { serverId, domainId } = c.req.valid("param");
      return c.json(await admin.generateDkimKey(serverId, domainId, await c.req.json()), 201);
    })
    .delete("/:serverId/dkim/:keyId", zValidator("param", key), async (c) => {
      const { serverId, keyId } = c.req.valid("param");
      await admin.deleteDkimKey(serverId, keyId);
      return c.json(ok);
    })
    .post("/:serverId/mailboxes", zValidator("param", server), zValidator("json", createMailboxInputSchema), async (c) =>
      c.json(await admin.createMailbox(c.req.valid("param").serverId, c.req.valid("json")), 201))
    .put("/:serverId/mailboxes/:mailboxId", zValidator("param", mailbox), zValidator("json", updateMailboxInputSchema), async (c) => {
      const { serverId, mailboxId } = c.req.valid("param");
      return c.json(await admin.updateMailbox(serverId, mailboxId, c.req.valid("json")));
    })
    .delete("/:serverId/mailboxes/:mailboxId", zValidator("param", mailbox), async (c) => {
      const { serverId, mailboxId } = c.req.valid("param");
      await admin.deleteMailbox(serverId, mailboxId, await c.req.json().catch(() => ({})));
      return c.json(ok);
    })
    .post("/:serverId/mailboxes/:mailboxId/password", zValidator("param", mailbox), async (c) => {
      const { serverId, mailboxId } = c.req.valid("param");
      await admin.resetPassword(serverId, mailboxId, await c.req.json());
      return c.json(ok);
    })
    .post("/:serverId/mailboxes/:mailboxId/aliases", zValidator("param", mailbox), async (c) => {
      const { serverId, mailboxId } = c.req.valid("param");
      return c.json(await admin.addAlias(serverId, mailboxId, await c.req.json()), 201);
    })
    .delete("/:serverId/mailboxes/:mailboxId/aliases", zValidator("param", mailbox), async (c) => {
      const { serverId, mailboxId } = c.req.valid("param");
      return c.json(await admin.removeAlias(serverId, mailboxId, await c.req.json()));
    })
    .post("/:serverId/mailboxes/:mailboxId/postreeve-account", zValidator("param", mailbox), async (c) => {
      const { serverId, mailboxId } = c.req.valid("param");
      return c.json(await admin.addMailboxToPostreeve(serverId, mailboxId), 201);
    })
    .post("/:serverId/lists", zValidator("param", server), zValidator("json", createMailingListInputSchema), async (c) =>
      c.json(await admin.createMailingList(c.req.valid("param").serverId, c.req.valid("json")), 201))
    .put("/:serverId/lists/:listId", zValidator("param", list), zValidator("json", updateMailingListInputSchema), async (c) => {
      const { serverId, listId } = c.req.valid("param");
      return c.json(await admin.updateMailingList(serverId, listId, c.req.valid("json")));
    })
    .delete("/:serverId/lists/:listId", zValidator("param", list), async (c) => {
      const { serverId, listId } = c.req.valid("param");
      await admin.deleteMailingList(serverId, listId);
      return c.json(ok);
    })
    .get("/:serverId/queue", zValidator("param", server), async (c) => c.json(await admin.queue(c.req.valid("param").serverId)))
    .post("/:serverId/queue/:messageId/retry", zValidator("param", queued), async (c) => {
      const { serverId, messageId } = c.req.valid("param");
      await admin.retryQueuedMessage(serverId, messageId);
      return c.json(ok);
    })
    .delete("/:serverId/queue/:messageId", zValidator("param", queued), async (c) => {
      const { serverId, messageId } = c.req.valid("param");
      await admin.cancelQueuedMessage(serverId, messageId);
      return c.json(ok);
    })
    .get("/:serverId/reports", zValidator("param", server), async (c) => c.json(await admin.reports(c.req.valid("param").serverId)))
    .get("/:serverId/spam", zValidator("param", server), async (c) => c.json(await admin.spamSettings(c.req.valid("param").serverId)))
    .put("/:serverId/spam", zValidator("param", server), async (c) =>
      c.json(await admin.updateSpamSettings(c.req.valid("param").serverId, await c.req.json())))
    .get("/:serverId/spam/:list", zValidator("param", spamList), async (c) => {
      const { serverId, list: name } = c.req.valid("param");
      return c.json(await admin.spamList(serverId, name));
    })
    .post("/:serverId/spam/:list", zValidator("param", spamList), async (c) => {
      const { serverId, list: name } = c.req.valid("param");
      return c.json(await admin.addSpamListEntry(serverId, name, await c.req.json()), 201);
    })
    .delete("/:serverId/spam/:list/:entryId", zValidator("param", spamEntry), async (c) => {
      const { serverId, list: name, entryId } = c.req.valid("param");
      await admin.removeSpamListEntry(serverId, name, entryId);
      return c.json(ok);
    })
    .onError((error, c) => {
      if (error instanceof MailServerError) return c.json({ error: error.message }, error.status === 401 ? 400 : error.status);
      if (error instanceof z.ZodError) return c.json({ error: error.issues.map((issue) => issue.message).join("; ") }, 400);
      return c.json({ error: error.message }, 400);
    });
}
