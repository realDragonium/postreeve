import {
  createDraftInputSchema,
  type Account,
  type CreateDraftInput,
  type Draft,
  type DraftContent,
  type UpdateDraftInput,
} from "../shared/contracts";
import { isLocalDraft, localDraftsKey } from "./mail-ui-state";

export class DraftSaveQueue {
  #draft: Draft | null;
  #tail: Promise<void> = Promise.resolve();
  readonly #accountId: string;
  readonly #create: (input: CreateDraftInput) => Promise<Draft>;
  readonly #update: (accountId: string, draftId: string, input: UpdateDraftInput) => Promise<Draft>;

  constructor(
    accountId: string,
    initialDraft: Draft | undefined,
    create: (input: CreateDraftInput) => Promise<Draft>,
    update: (accountId: string, draftId: string, input: UpdateDraftInput) => Promise<Draft>,
  ) {
    this.#accountId = accountId;
    this.#draft = initialDraft ?? null;
    this.#create = create;
    this.#update = update;
  }

  get current(): Draft | null {
    return this.#draft;
  }

  save(content: DraftContent): Promise<Draft> {
    const operation = this.#tail.then(async () => {
      this.#draft = this.#draft
        ? await this.#update(this.#accountId, this.#draft.id, { ...content, version: this.#draft.version })
        : await this.#create({ accountId: this.#accountId, ...content });
      return this.#draft;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
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
    storage.setItem(localDraftMigrationKey, "complete");
    return { migrated: 0, ignored: 1, retryable: 0 };
  }
  if (!Array.isArray(parsed)) {
    storage.setItem(localDraftMigrationKey, "complete");
    return { migrated: 0, ignored: 1, retryable: 0 };
  }

  const accountIds = new Set(accounts.map(({ id }) => id));
  const remaining: unknown[] = [];
  let migrated = 0;
  let ignored = 0;
  let retryable = 0;
  for (const candidate of parsed) {
    if (!isLocalDraft(candidate) || !accountIds.has(candidate.accountId)) {
      ignored += 1;
      remaining.push(candidate);
      continue;
    }
    const clientId = await migrationDraftId(candidate.accountId, candidate.id);
    const input = createDraftInputSchema.safeParse({
      accountId: candidate.accountId,
      clientId,
      mode: candidate.mode === "draft" ? "new" : candidate.mode,
      to: candidate.to,
      cc: candidate.cc,
      bcc: candidate.bcc,
      subject: candidate.subject,
      body: candidate.body,
      identity: { name: "", address: candidate.from },
      ...(candidate.source ? { source: candidate.source } : {}),
    });
    if (!input.success) {
      ignored += 1;
      remaining.push(candidate);
      continue;
    }
    try {
      await create(input.data);
      migrated += 1;
    } catch {
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
