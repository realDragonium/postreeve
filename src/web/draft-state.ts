import {
  createDraftInputSchema,
  outboundAddressSchema,
  type Account,
  type CreateDraftInput,
  type Draft,
  type DraftContent,
  type UpdateDraftInput,
} from "../shared/contracts";
import { ApiRequestError } from "./api";
import { isLocalDraft, localDraftsKey } from "./mail-ui-state";

export class DraftRecoveryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftRecoveryConflictError";
  }
}

export class DraftSaveQueue {
  #draft: Draft | null;
  readonly #uploadBases = new Map<string, Draft>();
  #tail: Promise<void> = Promise.resolve();
  readonly #accountId: string;
  readonly #clientId: string;
  readonly #submittedCreateContent = new Set<string>();
  readonly #create: (input: CreateDraftInput) => Promise<Draft>;
  readonly #update: (accountId: string, draftId: string, input: UpdateDraftInput) => Promise<Draft>;

  constructor(
    accountId: string,
    initialDraft: Draft | undefined,
    create: (input: CreateDraftInput) => Promise<Draft>,
    update: (accountId: string, draftId: string, input: UpdateDraftInput) => Promise<Draft>,
    clientId = initialDraft?.id ?? crypto.randomUUID(),
  ) {
    this.#accountId = accountId;
    this.#draft = initialDraft ?? null;
    this.#clientId = clientId;
    this.#create = create;
    this.#update = update;
  }

  isDirty(content: DraftContent): boolean {
    return this.#draft ? !sameDraftContent(this.#draft, content) : hasAuthoredContent(content);
  }

  get current(): Draft | null {
    return this.#draft;
  }

  save(content: DraftContent): Promise<Draft> {
    const operation = this.#tail.then(async () => {
      if (this.#draft) {
        if (sameDraftContent(this.#draft, content)) return this.#draft;
        const stored = await this.#update(
          this.#accountId,
          this.#draft.id,
          { ...content, version: this.#draft.version },
        );
        this.#assertBoundary(stored);
        if (!sameDraftContent(stored, content)) {
          throw new DraftRecoveryConflictError("Draft changed in another client while it was being saved");
        }
        this.#adoptSavedDraft(stored);
        return stored;
      }

      this.#submittedCreateContent.add(draftContentKey(content));
      const stored = await this.#create({ accountId: this.#accountId, clientId: this.#clientId, ...content });
      this.#assertBoundary(stored);
      if (stored.version !== 1
        || stored.delivery.status !== "editable"
        || !this.#submittedCreateContent.has(draftContentKey(stored))) {
        throw new DraftRecoveryConflictError("Draft changed in another client after its first save");
      }
      const reconciled = sameDraftContent(stored, content)
        ? stored
        : await this.#update(this.#accountId, stored.id, { ...content, version: stored.version });
      this.#assertBoundary(reconciled);
      if (!sameDraftContent(reconciled, content)) {
        throw new DraftRecoveryConflictError("Draft changed in another client while its first save was being recovered");
      }
      this.#adoptSavedDraft(reconciled);
      this.#submittedCreateContent.clear();
      return reconciled;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async uploadFile(
    content: DraftContent, id: string, file: File,
    upload: (accountId: string, draftId: string, version: number, id: string, file: File) => Promise<Draft>,
  ): Promise<Draft> {
    if (!this.#uploadBases.has(id)) {
      const saved = await this.save(content);
      this.#uploadBases.set(id, saved);
    }
    const operation = this.#tail.then(async () => {
      const base = this.#uploadBases.get(id);
      if (!base) throw new Error("Save the draft before attaching files");
      const stored = await upload(this.#accountId, base.id, base.version, id, file);
      this.#assertBoundary(stored);
      const attached = stored.attachments.find((attachment) => attachment.id === id);
      if (!attached || attached.size !== file.size || !sameDraftContent(stored, {
        ...base, attachments: [...base.attachments.filter((attachment) => attachment.id !== id), attached],
      })) {
        throw new DraftRecoveryConflictError("Draft changed in another client while the file was uploading");
      }
      this.#draft = stored;
      this.#uploadBases.set(id, stored);
      return attached;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    const attached = await operation;
    const stored = await this.save({
      ...content, attachments: [...content.attachments.filter((attachment) => attachment.id !== id), attached],
    });
    this.#uploadBases.delete(id);
    return stored;
  }

  async cancelUpload(
    content: DraftContent, id: string,
    load: (accountId: string, draftId: string) => Promise<Draft>,
  ): Promise<Draft> {
    const operation = this.#tail.then(async () => {
      const base = this.#uploadBases.get(id);
      if (!base) return;
      const stored = await load(this.#accountId, base.id);
      this.#assertBoundary(stored);
      const attachment = stored.attachments.find((attachment) => attachment.id === id);
      const expected = attachment
        ? { ...base, attachments: [...base.attachments.filter((candidate) => candidate.id !== id), attachment] }
        : base;
      if (!sameDraftContent(stored, expected)) {
        throw new DraftRecoveryConflictError("Draft changed in another client while the upload was being removed");
      }
      this.#draft = stored;
      this.#uploadBases.delete(id);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    await operation;
    return this.save({ ...content, attachments: content.attachments.filter((attachment) => attachment.id !== id) });
  }

  refreshAfterSend(load: (accountId: string, draftId: string) => Promise<Draft>): Promise<Draft | null> {
    const operation = this.#tail.then(async () => {
      if (!this.#draft) return null;
      const refreshed = await load(this.#accountId, this.#draft.id);
      this.#assertBoundary(refreshed);
      if (!sameDraftContent(refreshed, this.#draft)) {
        throw new DraftRecoveryConflictError("Draft changed in another client while send status was being recovered");
      }
      this.#draft = refreshed;
      return refreshed;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #adoptSavedDraft(stored: Draft): void {
    const previous = this.#draft;
    if (previous) {
      for (const [id, base] of this.#uploadBases) {
        if (base.version === previous.version && sameDraftContent(base, previous)) {
          this.#uploadBases.set(id, stored);
        }
      }
    }
    this.#draft = stored;
  }

  #assertBoundary(draft: Draft): void {
    if (draft.accountId !== this.#accountId || draft.id !== this.#clientId) {
      throw new Error("Draft response crossed its account or compose identity boundary");
    }
  }
}

function sameDraftContent(draft: Draft, content: DraftContent): boolean {
  return draftContentKey(draft) === draftContentKey(content);
}

function draftContentKey(content: DraftContent): string {
  return JSON.stringify([
    content.mode,
    recipientContentKey(content.to),
    recipientContentKey(content.cc),
    recipientContentKey(content.bcc),
    content.subject,
    content.body,
    [content.identity.name, content.identity.address],
    content.source
      ? [content.source.canonicalMessageId, content.source.conversationId, content.source.providerConversationId ?? null]
      : null,
    content.attachments.map(({ id, name, size, type }) => [id ?? null, name, size, type]),
  ]);
}

function recipientContentKey(value: DraftContent["to"]) {
  return typeof value === "string"
    ? ["text", value]
    : ["structured", value.map(({ name, address }) => [name, address])];
}

function hasAuthoredContent(content: DraftContent): boolean {
  return [content.to, content.cc, content.bcc]
    .some((value) => typeof value === "string" ? value.trim().length > 0 : value.length > 0)
    || content.subject.trim().length > 0
    || content.body.trim().length > 0
    || content.attachments.length > 0;
}

export const localDraftMigrationKey = "postreeve.local-drafts.migrated.v2";

export interface DraftMigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DraftMigrationResult {
  readonly migrated: number;
  readonly ignored: number;
  readonly retryable: number;
}

export async function migrateLocalDraftsOnce(
  storage: DraftMigrationStorage,
  accounts: readonly Account[],
  create: (input: CreateDraftInput) => Promise<Draft>,
): Promise<DraftMigrationResult> {
  if (storage.getItem(localDraftMigrationKey) === "complete") {
    return { migrated: 0, ignored: 0, retryable: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(localDraftsKey) ?? "[]");
  } catch {
    storage.setItem(localDraftsKey, "[]");
    storage.setItem(localDraftMigrationKey, "complete");
    return { migrated: 0, ignored: 1, retryable: 0 };
  }
  if (!Array.isArray(parsed)) {
    storage.setItem(localDraftsKey, "[]");
    storage.setItem(localDraftMigrationKey, "complete");
    return { migrated: 0, ignored: 1, retryable: 0 };
  }

  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const remaining: unknown[] = [];
  let migrated = 0;
  let ignored = 0;
  let retryable = 0;
  for (const candidate of parsed) {
    if (!isLocalDraft(candidate)) {
      ignored += 1;
      continue;
    }
    const account = accountsById.get(candidate.accountId);
    if (!account) {
      retryable += 1;
      remaining.push(candidate);
      continue;
    }
    const clientId = await migrationDraftId(candidate.accountId, candidate.id);
    const legacyIdentity = outboundAddressSchema.safeParse({
      name: candidate.from === account.email ? account.name : "",
      address: candidate.from,
    });
    const input = createDraftInputSchema.safeParse({
      accountId: candidate.accountId,
      clientId,
      mode: candidate.mode === "draft" ? "new" : candidate.mode,
      to: candidate.to,
      cc: candidate.cc,
      bcc: candidate.bcc,
      subject: candidate.subject,
      body: candidate.body,
      identity: legacyIdentity.success
        ? legacyIdentity.data
        : { name: account.name, address: account.email },
      attachments: candidate.attachments,
      ...(candidate.source ? { source: candidate.source } : {}),
    });
    if (!input.success) {
      ignored += 1;
      continue;
    }
    try {
      await create(input.data);
      migrated += 1;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 410 && error.code === "draft_deleted") {
        continue;
      }
      retryable += 1;
      remaining.push(candidate);
    }
  }
  storage.setItem(localDraftsKey, JSON.stringify(remaining));
  if (retryable === 0) storage.setItem(localDraftMigrationKey, "complete");
  return { migrated, ignored, retryable };
}

export async function migrationDraftId(accountId: string, localId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${accountId}\0${localId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `local-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
