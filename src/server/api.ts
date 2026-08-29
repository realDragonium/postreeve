import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  accountIdSchema,
  batchIdSchema,
  createAccountInputSchema,
  createProposalInputSchema,
  directActionInputSchema,
  listMessagesInputSchema,
  messageRefSchema,
  proposalIdSchema,
  sendMessageInputSchema,
  updateProposalInputSchema,
} from "../shared/contracts";
import type { PostreeveService } from "./core/postreeve";

const accountParamsSchema = z.object({ accountId: accountIdSchema });
const proposalParamsSchema = z.object({ proposalId: proposalIdSchema });
const batchParamsSchema = z.object({ batchId: batchIdSchema });
const messageQuerySchema = z.object({
  mailbox: z.string().min(1),
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const accountQuerySchema = z.object({ accountId: accountIdSchema });
const readMessagesSchema = z.object({ references: z.array(messageRefSchema).min(1).max(100) });

export function createApi(service: PostreeveService) {
  return new Hono()
    .basePath("/api")
    .get("/health", (context) => context.json({ ok: true as const }))
    .get("/accounts", async (context) => context.json(await service.listAccounts()))
    .post("/accounts", zValidator("json", createAccountInputSchema), async (context) =>
      context.json(await service.createAccount(context.req.valid("json")), 201))
    .get("/accounts/:accountId/folders", zValidator("param", accountParamsSchema), async (context) =>
      context.json(await service.listFolders(context.req.valid("param").accountId)))
    .get(
      "/accounts/:accountId/messages",
      zValidator("param", accountParamsSchema),
      zValidator("query", messageQuerySchema),
      async (context) => {
        const { accountId } = context.req.valid("param");
        const query = context.req.valid("query");
        return context.json(await service.listMessages(listMessagesInputSchema.parse({ accountId, ...query })));
      },
    )
    .post("/messages/read", zValidator("json", readMessagesSchema), async (context) =>
      context.json(await service.readMessages(context.req.valid("json").references)))
    .post("/messages/send", zValidator("json", sendMessageInputSchema), async (context) =>
      context.json(await service.sendMessage(context.req.valid("json")), 201))
    .post("/messages/actions", zValidator("json", directActionInputSchema), async (context) =>
      context.json(await service.applyDirectActions(context.req.valid("json"))))
    .get("/proposals", zValidator("query", accountQuerySchema), async (context) =>
      context.json(await service.listProposals(context.req.valid("query").accountId)))
    .post("/proposals", zValidator("json", createProposalInputSchema), async (context) =>
      context.json(await service.createProposal(context.req.valid("json")), 201))
    .put(
      "/proposals/:proposalId",
      zValidator("param", proposalParamsSchema),
      zValidator("json", updateProposalInputSchema),
      async (context) => context.json(await service.updateProposal(
        context.req.valid("param").proposalId,
        context.req.valid("json"),
      )),
    )
    .post("/proposals/:proposalId/approve", zValidator("param", proposalParamsSchema), async (context) =>
      context.json(await service.approveProposalFromHumanInterface(context.req.valid("param").proposalId)))
    .post("/proposals/:proposalId/apply", zValidator("param", proposalParamsSchema), async (context) =>
      context.json(await service.applyApprovedProposal(context.req.valid("param").proposalId)))
    .get("/batches", zValidator("query", accountQuerySchema), async (context) =>
      context.json(await service.listBatches(context.req.valid("query").accountId)))
    .post("/batches/:batchId/undo", zValidator("param", batchParamsSchema), async (context) =>
      context.json(await service.undoBatch(context.req.valid("param").batchId)))
    .onError((error, context) => {
      return context.json({ error: error.message }, 400);
    });
}

export type AppType = ReturnType<typeof createApi>;
