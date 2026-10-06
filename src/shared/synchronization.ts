import { z } from "zod";
import { accountSchema } from "./contracts";

export const retentionPolicySchema = z.object({
  maxAgeDays: z.number().int().min(1).max(3650),
  maxContentBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export const defaultRetentionPolicy: RetentionPolicy = { maxAgeDays: 30, maxContentBytes: 100 * 1024 * 1024 };
export const synchronizationFailureSchema = z.enum(["provider", "reauthorization", "invalid-data"]);
export const accountHealthSchema = z.object({
  account: accountSchema,
  state: z.enum(["healthy", "catching-up", "degraded", "disconnected", "reauthorization-required"]),
  coverage: z.enum(["partial", "catching-up", "complete"]),
  lastSuccessAt: z.number().nullable(),
  failure: z.object({ kind: synchronizationFailureSchema, at: z.number(), message: z.string() }).nullable(),
  guidance: z.string(),
  retryAvailable: z.boolean(),
  nextAttemptAt: z.number().nullable(),
  retainedContentBytes: z.number().int().nonnegative(),
});
export type AccountHealth = z.infer<typeof accountHealthSchema>;
export const synchronizationStatusSchema = z.object({
  accounts: z.array(accountHealthSchema), retention: retentionPolicySchema,
});
export type SynchronizationStatus = z.infer<typeof synchronizationStatusSchema>;
export const reauthorizationSchema = z.object({
  accountId: z.string().min(1), method: z.enum(["google-consent", "account-settings"]),
  instructions: z.string(),
});
export type Reauthorization = z.infer<typeof reauthorizationSchema>;
