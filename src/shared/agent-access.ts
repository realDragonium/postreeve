import { z } from "zod";

export const agentScopes = ["mail:read", "mail:propose", "mail:draft", "mail:act"] as const;
export const agentScopeSchema = z.enum(agentScopes);
export type AgentScope = z.infer<typeof agentScopeSchema>;

/** Scopes are offered as cumulative tiers: a person decides how much an agent may do, not a matrix. */
export const agentTiers = {
  read: { label: "Read only", scopes: ["mail:read"] },
  propose: { label: "Read and prepare", scopes: ["mail:read", "mail:propose", "mail:draft"] },
  act: { label: "Read, prepare and act", scopes: ["mail:read", "mail:propose", "mail:draft", "mail:act"] },
} as const satisfies Record<string, { label: string; scopes: readonly AgentScope[] }>;
export type AgentTier = keyof typeof agentTiers;
export const agentTierSchema = z.enum(["read", "propose", "act"]);

export function tierOf(scopes: readonly string[]): AgentTier {
  if (scopes.includes("mail:act")) return "act";
  if (scopes.includes("mail:propose") || scopes.includes("mail:draft")) return "propose";
  return "read";
}

export const connectedAgentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["oauth", "token"]),
  name: z.string(),
  redirectHost: z.string().nullable(),
  tier: agentTierSchema,
  scopes: z.array(agentScopeSchema),
  accountIds: z.array(z.string()).nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type ConnectedAgent = z.infer<typeof connectedAgentSchema>;

export const createPersonalTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  tier: agentTierSchema,
  accountIds: z.array(z.string().min(1)).min(1).max(100).nullable(),
});
export type CreatePersonalTokenInput = z.infer<typeof createPersonalTokenInputSchema>;

export const createdPersonalTokenSchema = z.object({ agent: connectedAgentSchema, token: z.string().min(1) });
export type CreatedPersonalToken = z.infer<typeof createdPersonalTokenSchema>;

export const agentEventSchema = z.object({
  id: z.number().int(),
  grantId: z.string(),
  agentName: z.string(),
  tool: z.string(),
  accountId: z.string().nullable(),
  outcome: z.enum(["ok", "error"]),
  summary: z.string(),
  error: z.string().nullable(),
  targetKind: z.enum(["batch", "proposal"]).nullable(),
  targetId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;
