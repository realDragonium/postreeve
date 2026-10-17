import { z } from "zod";
import { dnsRecordSchema } from "./mail-server";

// Contracts for DNS provider sync (server/dns-providers).

export const dnsProviderKindSchema = z.enum(["cloudflare", "godaddy"]);

export const dnsProviderCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloudflare"), apiToken: z.string().trim().min(1).max(512) }),
  z.object({ kind: z.literal("godaddy"), apiKey: z.string().trim().min(1).max(256), apiSecret: z.string().trim().min(1).max(256) }),
]);

export const dnsProviderSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  kind: dnsProviderKindSchema,
  createdAt: z.iso.datetime(),
});

export const dnsProviderSummarySchema = dnsProviderSchema.extend({
  zones: z.array(z.string()).nullable(),
  error: z.string().nullable(),
});

export const connectDnsProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  credential: dnsProviderCredentialSchema,
});

export const dnsChangeSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["create", "update", "delete"]),
  type: z.string(),
  name: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** Whether Postreeve created the record this change touches; always true for a create. */
  owned: z.boolean(),
  selected: z.boolean(),
  reason: z.string(),
});

export const dnsPlanSchema = z.object({
  domain: z.string(),
  status: z.enum(["ready", "no-provider", "unavailable"]),
  providerId: z.string().nullable(),
  providerName: z.string().nullable(),
  zone: z.string().nullable(),
  reason: z.string().nullable(),
  fingerprint: z.string(),
  inSync: z.number().int().nonnegative(),
  changes: z.array(dnsChangeSchema),
  /** Required records this sync does not publish (for example CAA); copy them from the checklist. */
  manual: z.array(dnsRecordSchema),
});

export const applyDnsPlanInputSchema = z.object({
  fingerprint: z.string().min(1).max(128),
  changeIds: z.array(z.string().min(1).max(64)).max(200),
});

export const dnsApplyResultSchema = z.object({
  domain: z.string(),
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), message: z.string() })),
});

export type DnsProviderKind = z.infer<typeof dnsProviderKindSchema>;
export type DnsProviderCredential = z.infer<typeof dnsProviderCredentialSchema>;
export type DnsProvider = z.infer<typeof dnsProviderSchema>;
export type DnsProviderSummary = z.infer<typeof dnsProviderSummarySchema>;
export type ConnectDnsProviderInput = z.input<typeof connectDnsProviderInputSchema>;
export type DnsChange = z.infer<typeof dnsChangeSchema>;
export type DnsPlan = z.infer<typeof dnsPlanSchema>;
export type ApplyDnsPlanInput = z.input<typeof applyDnsPlanInputSchema>;
export type DnsApplyResult = z.infer<typeof dnsApplyResultSchema>;
