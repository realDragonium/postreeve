import { z } from "zod";
import { accountIdSchema } from "./contracts";

export const newMailArrivalSchema = z.object({
  canonicalId: z.string().min(1),
  mailbox: z.string().min(1),
  sender: z.string(),
  subject: z.string(),
  receivedAt: z.string(),
});
export type NewMailArrival = z.infer<typeof newMailArrivalSchema>;

export const mailboxEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mailbox-changed"), accountId: accountIdSchema }),
  z.object({ type: z.literal("new-mail"), accountId: accountIdSchema, arrivals: z.array(newMailArrivalSchema).min(1) }),
]);
export type MailboxEvent = z.infer<typeof mailboxEventSchema>;

export function isInbox(mailbox: string): boolean {
  return mailbox.toUpperCase() === "INBOX";
}
