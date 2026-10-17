import { z } from "zod";
import {
  createMailServerProposalInputSchema,
  dnsCheckSchema,
  mailServerIdSchema,
  mailServerProposalSchema,
  queuedMessageSchema,
  type MailServerProposal,
} from "../../shared/mail-server";
import type { WebMcpTool } from "../webmcp/types";
import type { MailServerAdmin } from "./service";

// Shared agent tools for the mail server (agents/mail-server-tools). The read tools return no secret and
// no message content; the one write tool only stores a proposal that the owner approves in the UI.

const readOnlyAnnotations = { readOnlyHint: true, untrustedContentHint: true } as const;
const mutatingAnnotations = { readOnlyHint: false, untrustedContentHint: true } as const;

const noInputSchema = z.object({}).strict();
const serverInputSchema = z.object({ serverId: mailServerIdSchema }).strict();
const dnsInputSchema = z.object({ serverId: mailServerIdSchema, domain: z.string().trim().toLowerCase().min(1).max(253) }).strict();
const proposeInputSchema = createMailServerProposalInputSchema.extend({ serverId: mailServerIdSchema }).strict();

const serverListSchema = z.array(z.object({
  id: z.string(), name: z.string(), baseUrl: z.string(), mailHostname: z.string(),
  domainCount: z.number().nullable(), error: z.string().nullable(),
}).strict());
const domainListSchema = z.array(z.object({
  name: z.string(), enabled: z.boolean(), catchAll: z.string().nullable(), aliases: z.array(z.string()),
  mailboxes: z.number().int(), mailingLists: z.number().int(),
}).strict());
const dnsResultSchema = z.object({
  domain: z.string(), resolver: z.string(), checkedAt: z.string(),
  summary: z.object({ ok: z.number(), missing: z.number(), different: z.number(), error: z.number() }),
  records: z.array(dnsCheckSchema),
}).strict();
const queueResultSchema = z.object({ total: z.number().int(), deferred: z.number().int(), failed: z.number().int(), messages: z.array(queuedMessageSchema) }).strict();

const inputJsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" });

export type MailServerToolServices = Pick<MailServerAdmin,
  "listServers" | "domains" | "mailboxes" | "mailingLists" | "dnsChecklist" | "queue" | "createProposal">;

/** Builds the mail server tools; `agentName` is recorded on proposals the agent prepares. */
export function mailServerTools(admin: MailServerToolServices, agentName = "agent"): readonly WebMcpTool[] {
  return [
    {
      name: "list_mail_servers", title: "List connected mail servers",
      description: "List the Stalwart mail servers connected to Postreeve with their admin URL, mail hostname and domain count.",
      inputSchema: inputJsonSchema(noInputSchema), annotations: readOnlyAnnotations,
      execute: async (input) => {
        noInputSchema.parse(input);
        return serverListSchema.parse((await admin.listServers()).map(({ id, name, baseUrl, mailHostname, domainCount, error }) =>
          ({ id, name, baseUrl, mailHostname, domainCount, error })));
      },
    },
    {
      name: "list_mail_server_domains", title: "List a mail server's domains",
      description: "List a mail server's domains with catch-all address, domain aliases and how many mailboxes and mailing lists each has.",
      inputSchema: inputJsonSchema(serverInputSchema), annotations: readOnlyAnnotations,
      execute: async (input) => {
        const { serverId } = serverInputSchema.parse(input);
        const [domains, mailboxes, lists] = await Promise.all([admin.domains(serverId), admin.mailboxes(serverId), admin.mailingLists(serverId)]);
        return domainListSchema.parse(domains.map((domain) => ({
          name: domain.name, enabled: domain.enabled, catchAll: domain.catchAll, aliases: domain.aliases,
          mailboxes: mailboxes.filter(({ domainId }) => domainId === domain.id).length,
          mailingLists: lists.filter(({ domainId }) => domainId === domain.id).length,
        })));
      },
    },
    {
      name: "check_mail_server_dns", title: "Check a domain's DNS records",
      description: "Compare the DNS records a mail server domain needs (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, autoconfig, SRV) with what public DNS answers now.",
      inputSchema: inputJsonSchema(dnsInputSchema), annotations: readOnlyAnnotations,
      execute: async (input) => {
        const { serverId, domain } = dnsInputSchema.parse(input);
        const match = (await admin.domains(serverId)).find(({ name }) => name === domain);
        if (!match) throw new Error(`${domain} is not a domain on this mail server`);
        const checklist = await admin.dnsChecklist(serverId, match.id);
        const summary = { ok: 0, missing: 0, different: 0, error: 0 };
        for (const record of checklist.records) summary[record.status] += 1;
        return dnsResultSchema.parse({ domain: checklist.domain, resolver: checklist.resolver, checkedAt: checklist.checkedAt, summary, records: checklist.records });
      },
    },
    {
      name: "inspect_mail_server_queue", title: "Inspect the outgoing mail queue",
      description: "List messages waiting in the mail server's delivery queue with sender, recipient addresses, delivery status, retry count and last error. Message contents are not included.",
      inputSchema: inputJsonSchema(serverInputSchema), annotations: readOnlyAnnotations,
      execute: async (input) => {
        const { serverId } = serverInputSchema.parse(input);
        const messages = await admin.queue(serverId);
        const has = (status: string) => messages.filter((message) => message.recipients.some((recipient) => recipient.status === status)).length;
        return queueResultSchema.parse({ total: messages.length, deferred: has("temporaryFailure"), failed: has("permanentFailure"), messages });
      },
    },
    {
      name: "propose_mail_server_change", title: "Propose a mail server change",
      description: "Prepare a list of mail server changes (domains, mailboxes, aliases, catch-all, mailing lists, DKIM keys, quotas, spam settings, queue retries) for the owner to review. Nothing changes until the owner approves it in Postreeve; mailbox passwords are set by the owner at approval.",
      inputSchema: inputJsonSchema(proposeInputSchema), annotations: mutatingAnnotations,
      execute: async (input) => {
        const { serverId, ...proposal } = proposeInputSchema.parse(input);
        return mailServerProposalSchema.parse(admin.createProposal(serverId, proposal, agentName)) satisfies MailServerProposal;
      },
    },
  ];
}
