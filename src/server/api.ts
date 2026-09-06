import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  accountIdSchema,
  batchIdSchema,
  createAccountInputSchema,
  createDraftInputSchema,
  createFolderInputSchema,
  createProposalInputSchema,
  deleteFolderInputSchema,
  directActionInputSchema,
  draftIdSchema,
  draftFileUploadSchema,
  draftVersionInputSchema,
  listMessagesInputSchema,
  messageRefSchema,
  proposalIdSchema,
  renameFolderInputSchema,
  sendMessageInputSchema,
  updateDraftInputSchema,
  updateProposalInputSchema,
  updateAccountInputSchema,
} from "../shared/contracts";
import type { PostreeveService } from "./core/postreeve";
import { attachmentDisposition } from "./core/attachment-reference";
import { AccountConflictError, DraftConflictError, DraftDeletedError, DraftNotFoundError } from "./core/errors";
import type { GoogleOAuth } from "./google/oauth";

const accountParamsSchema = z.object({ accountId: accountIdSchema });
const draftParamsSchema = z.object({ accountId: accountIdSchema, draftId: draftIdSchema });
const proposalParamsSchema = z.object({ proposalId: proposalIdSchema });
const batchParamsSchema = z.object({ batchId: batchIdSchema });
const conversationParamsSchema = z.object({ conversationId: z.string().min(1) });
const attachmentParamsSchema = z.object({
  accountId: accountIdSchema,
  canonicalMessageId: z.string().min(1),
  reference: z.string().min(1).max(8_000),
});
const messageQuerySchema = z.object({
  mailbox: z.string().min(1),
  query: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const accountQuerySchema = z.object({ accountId: accountIdSchema });
const readMessagesSchema = z.object({ references: z.array(messageRefSchema).min(1).max(100) });

export interface ApiOptions {
  readonly oauthReturnUrl?: string | undefined;
}

export function createApi(service: PostreeveService, googleOAuth?: GoogleOAuth, options: ApiOptions = {}) {
  return new Hono()
    .basePath("/api")
    .get("/health", (context) => context.json({ ok: true as const }))
    .get("/oauth/google/status", (context) => context.json({ configured: Boolean(googleOAuth) }))
    .get("/oauth/google/start", (context) => {
      if (!googleOAuth) throw new Error("Google account connection is not configured on this Postreeve server");
      return context.redirect(googleOAuth.start());
    })
    .get("/oauth/google/callback", async (context) => {
      if (!googleOAuth) throw new Error("Google account connection is not configured on this Postreeve server");
      try {
        const authorized = await googleOAuth.complete(context.req.url);
        const account = await service.connectGmailAccount(authorized.email, authorized.refreshToken);
        return context.redirect(oauthResultUrl(options.oauthReturnUrl, "connected", account.id));
      } catch (error) {
        console.error(`Google account connection failed: ${safeOAuthError(error)}`);
        return context.redirect(oauthResultUrl(options.oauthReturnUrl, "error"));
      }
    })
    .get("/accounts", async (context) => context.json(await service.listAccounts()))
    .post("/accounts/test", zValidator("json", createAccountInputSchema), async (context) => {
      await service.testNewAccountConnection(context.req.valid("json"));
      return context.json({ ok: true as const });
    })
    .post("/accounts", zValidator("json", createAccountInputSchema), async (context) =>
      context.json(await service.createAccount(context.req.valid("json")), 201))
    .get("/accounts/:accountId/settings", zValidator("param", accountParamsSchema), async (context) =>
      context.json(await service.getAccountSettings(context.req.valid("param").accountId)))
    .post(
      "/accounts/:accountId/test",
      zValidator("param", accountParamsSchema),
      zValidator("json", updateAccountInputSchema),
      async (context) => {
        await service.testAccountConnection(
          context.req.valid("param").accountId,
          context.req.valid("json"),
        );
        return context.json({ ok: true as const });
      },
    )
    .put(
      "/accounts/:accountId",
      zValidator("param", accountParamsSchema),
      zValidator("json", updateAccountInputSchema),
      async (context) => context.json(await service.updateAccount(
        context.req.valid("param").accountId,
        context.req.valid("json"),
      )),
    )
    .delete("/accounts/:accountId", zValidator("param", accountParamsSchema), async (context) => {
      await service.removeAccount(context.req.valid("param").accountId);
      return context.json({ ok: true as const });
    })
    .get("/accounts/:accountId/folders", zValidator("param", accountParamsSchema), async (context) =>
      context.json(await service.listFolders(context.req.valid("param").accountId)))
    .post(
      "/accounts/:accountId/folders",
      zValidator("param", accountParamsSchema),
      zValidator("json", createFolderInputSchema.omit({ accountId: true })),
      async (context) => context.json(await service.createFolder({
        accountId: context.req.valid("param").accountId,
        ...context.req.valid("json"),
      }), 201),
    )
    .put(
      "/accounts/:accountId/folders",
      zValidator("param", accountParamsSchema),
      zValidator("json", renameFolderInputSchema.omit({ accountId: true })),
      async (context) => context.json(await service.renameFolder({
        accountId: context.req.valid("param").accountId,
        ...context.req.valid("json"),
      })),
    )
    .delete(
      "/accounts/:accountId/folders",
      zValidator("param", accountParamsSchema),
      zValidator("json", deleteFolderInputSchema.omit({ accountId: true })),
      async (context) => context.json(await service.deleteFolder({
        accountId: context.req.valid("param").accountId,
        ...context.req.valid("json"),
      })),
    )
    .get("/outgoing-mail-limits", (context) => context.json(service.outgoingMailLimits))
    .post("/accounts/:accountId/drafts/:draftId/files", zValidator("param", draftParamsSchema), async (context) => {
      const { accountId, draftId } = context.req.valid("param");
      const metadata = draftFileUploadSchema.parse(JSON.parse(decodeURIComponent(context.req.header("X-Postreeve-File") ?? "")));
      const limit = service.outgoingMailLimits.maxUploadBytes;
      const declaredSize = Number(context.req.header("Content-Length"));
      if (Number.isFinite(declaredSize) && declaredSize > limit) {
        return context.json({ error: `File exceeds the ${limit}-byte upload limit` }, 413);
      }
      const reader = context.req.raw.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) {
              await reader.cancel();
              return context.json({ error: `File exceeds the ${limit}-byte upload limit` }, 413);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      return context.json(await service.uploadDraftFile(accountId, draftId, metadata.version, {
        id: metadata.id, name: metadata.name, type: metadata.type, content: Buffer.concat(chunks, length),
      }));
    })
    .get("/accounts/:accountId/drafts/:draftId/files/:fileId", zValidator("param", draftParamsSchema.extend({ fileId: z.uuid() })), async (context) => {
      const { accountId, draftId, fileId } = context.req.valid("param");
      const file = await service.downloadDraftFile(accountId, draftId, fileId);
      return new Response(Buffer.from(file.content), { headers: {
        "Content-Type": file.type, "Content-Disposition": attachmentDisposition(file.name),
        "Content-Length": String(file.content.byteLength), "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    })
    .get("/accounts/:accountId/drafts", zValidator("param", accountParamsSchema), async (context) =>
      context.json(await service.listDrafts(context.req.valid("param").accountId)))
    .post(
      "/accounts/:accountId/drafts",
      zValidator("param", accountParamsSchema),
      zValidator("json", createDraftInputSchema.omit({ accountId: true })),
      async (context) => context.json(await service.createDraft({
        accountId: context.req.valid("param").accountId,
        ...context.req.valid("json"),
      }), 201),
    )
    .get(
      "/accounts/:accountId/drafts/:draftId",
      zValidator("param", draftParamsSchema),
      async (context) => {
        const { accountId, draftId } = context.req.valid("param");
        return context.json(await service.getDraft(accountId, draftId));
      },
    )
    .put(
      "/accounts/:accountId/drafts/:draftId",
      zValidator("param", draftParamsSchema),
      zValidator("json", updateDraftInputSchema),
      async (context) => {
        const { accountId, draftId } = context.req.valid("param");
        return context.json(await service.updateDraft(accountId, draftId, context.req.valid("json")));
      },
    )
    .delete(
      "/accounts/:accountId/drafts/:draftId",
      zValidator("param", draftParamsSchema),
      zValidator("json", draftVersionInputSchema),
      async (context) => {
        const { accountId, draftId } = context.req.valid("param");
        await service.removeDraft(accountId, draftId, context.req.valid("json"));
        return context.json({ ok: true as const });
      },
    )
    .post(
      "/accounts/:accountId/drafts/:draftId/copy",
      zValidator("param", draftParamsSchema),
      zValidator("json", draftVersionInputSchema),
      async (context) => {
        const { accountId, draftId } = context.req.valid("param");
        return context.json(await service.copyDraftForRecovery(accountId, draftId, context.req.valid("json")), 201);
      },
    )
    .post(
      "/accounts/:accountId/drafts/:draftId/send",
      zValidator("param", draftParamsSchema),
      zValidator("json", draftVersionInputSchema),
      async (context) => {
        const { accountId, draftId } = context.req.valid("param");
        return context.json(await service.sendDraft(accountId, draftId, context.req.valid("json")));
      },
    )
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
    .get(
      "/accounts/:accountId/messages/:canonicalMessageId/attachments/:reference",
      zValidator("param", attachmentParamsSchema),
      async (context) => {
        const { accountId, canonicalMessageId, reference } = context.req.valid("param");
        const attachment = await service.downloadAttachment(accountId, canonicalMessageId, reference);
        return new Response(Buffer.from(attachment.content), {
          headers: {
            "Content-Type": attachment.mediaType,
            "Content-Disposition": attachmentDisposition(attachment.filename),
            "Content-Length": String(attachment.content.byteLength),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    )
    .get("/conversations/:conversationId", zValidator("param", conversationParamsSchema), async (context) =>
      context.json(await service.getConversation(context.req.valid("param").conversationId)))
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
      if (error instanceof AccountConflictError) {
        return context.json({ error: error.message, code: "account_conflict" as const }, 409);
      }
      if (error instanceof DraftNotFoundError) {
        return context.json({ error: error.message, code: "draft_not_found" as const }, 404);
      }
      if (error instanceof DraftDeletedError) {
        return context.json({ error: error.message, code: "draft_deleted" as const }, 410);
      }
      if (error instanceof DraftConflictError) {
        return context.json({ error: error.message, code: "draft_conflict" as const }, 409);
      }
      return context.json({ error: error.message }, 400);
    });
}

export type AppType = ReturnType<typeof createApi>;

export function oauthResultUrl(
  returnUrl: string | undefined,
  result: "connected" | "error",
  accountId?: string,
): string {
  const query = new URLSearchParams({ google: result });
  if (accountId) query.set("accountId", accountId);
  if (!returnUrl) return `/?${query.toString()}`;

  const url = new URL(returnUrl);
  url.search = query.toString();
  return url.toString();
}

function safeOAuthError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown authorization failure";
  const message = error.message.replace(/[\r\n]/g, " ").slice(0, 300);
  return message || "Unknown authorization failure";
}
