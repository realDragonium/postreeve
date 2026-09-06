import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  Account,
  CanonicalConversation,
  CanonicalMessage,
  CanonicalMessageObservation,
  Draft,
  DraftContent,
  MailProviderKind,
  MessageRef,
  OperationBatch,
  Proposal,
  SendReceipt,
} from "../../shared/contracts";
import { draftSchema, sendReceiptSchema } from "../../shared/contracts";
import { DraftConflictError, DraftNotFoundError } from "../core/errors";
import { accounts, batches, drafts, proposals, type StoredOperation } from "./schema";
import { normalizeMessageId, normalizeMessageIdList, normalizeMessageIdLists } from "../mail/message-id";
import type { ProviderMessageObservation } from "../mail/provider";
import type { ConversationSendContext } from "../mail/sender";
import {
  mergeThreadingMetadata,
  orderConversationMessages,
  type ThreadingMetadata,
} from "../mail/conversation";

export type StoredAccount = Account & { encryptedCredentials: string | null };

export interface StoredBatch extends OperationBatch {
  storedOperations: StoredOperation[];
}

export interface MailboxSnapshot {
  tenantId: string;
  accountId: string;
  provider: MailProviderKind;
  mailbox: string;
  observations: ProviderMessageObservation[];
  authoritative: boolean;
}

export type StoredMessageLocation = CanonicalMessageObservation["location"] & {
  id: string;
  messageId: string;
  tenantId: string;
  observedAt: string;
};

export type DraftSendClaim =
  | { kind: "claimed"; draft: Draft }
  | { kind: "sent"; receipt: SendReceipt };

export class Store {
  readonly #sqlite: Database;
  readonly #db: BunSQLiteDatabase;

  constructor(path = process.env.POSTREEVE_DB_PATH ?? "./data/postreeve.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#sqlite = new Database(path, { create: true, strict: true });
    this.#sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
    this.#db = drizzle(this.#sqlite);
  }

  close(): void {
    this.#sqlite.close();
  }

  async listAccounts(): Promise<StoredAccount[]> {
    return this.#db.select({
      id: accounts.id,
      name: accounts.name,
      email: accounts.email,
      kind: accounts.kind,
      encryptedCredentials: accounts.encryptedCredentials,
    }).from(accounts).orderBy(accounts.createdAt);
  }

  async getAccount(id: string): Promise<StoredAccount | null> {
    const rows = await this.#db.select({
      id: accounts.id,
      name: accounts.name,
      email: accounts.email,
      kind: accounts.kind,
      encryptedCredentials: accounts.encryptedCredentials,
    }).from(accounts).where(eq(accounts.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async insertAccount(account: StoredAccount): Promise<void> {
    await this.#db.insert(accounts).values({
      id: account.id,
      name: account.name,
      email: account.email,
      kind: account.kind,
      encryptedCredentials: account.encryptedCredentials,
      createdAt: new Date().toISOString(),
    });
  }

  async updateAccount(account: StoredAccount): Promise<void> {
    await this.#db.update(accounts).set({
      name: account.name,
      email: account.email,
      encryptedCredentials: account.encryptedCredentials,
    }).where(eq(accounts.id, account.id));
  }

  async deleteAccount(id: string): Promise<boolean> {
    const account = await this.getAccount(id);
    if (!account) return false;
    const remove = this.#sqlite.transaction((accountId: string) => {
      this.#sqlite.query("DELETE FROM drafts WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM message_provider_conversations WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM message_locations WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM message_provider_associations WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM operation_batches WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM proposals WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM accounts WHERE id = ?").run(accountId);
    });
    remove(id);
    return true;
  }

  async insertDraft(tenantId: string, draft: Draft): Promise<void> {
    await this.#db.insert(drafts).values({
      id: draft.id,
      tenantId,
      accountId: draft.accountId,
      mode: draft.mode,
      recipientsTo: draft.to,
      recipientsCc: draft.cc,
      recipientsBcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      identity: draft.identity,
      source: draft.source ?? null,
      deliveryStatus: "editable",
      deliveryReceipt: null,
      deliveryError: null,
      claimedAt: null,
      claimOwner: null,
      settledAt: null,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      version: draft.version,
    });
  }

  async listDrafts(tenantId: string, accountId: string): Promise<Draft[]> {
    const rows = this.#sqlite.query(`
      SELECT * FROM drafts
      WHERE tenant_id = ? AND account_id = ? AND delivery_status <> 'sent'
      ORDER BY updated_at DESC, id
    `).all(tenantId, accountId) as DraftRow[];
    return rows.map(toDraft);
  }

  async getDraft(tenantId: string, accountId: string, id: string): Promise<Draft | null> {
    const row = this.#draftRow(tenantId, accountId, id);
    return row ? toDraft(row) : null;
  }

  async updateDraft(
    tenantId: string,
    accountId: string,
    id: string,
    expectedVersion: number,
    content: DraftContent,
    updatedAt: string,
  ): Promise<Draft> {
    const row = this.#sqlite.query(`
      UPDATE drafts SET
        mode = ?, recipients_to = ?, recipients_cc = ?, recipients_bcc = ?, subject = ?, body = ?,
        identity = ?, source = ?, delivery_status = 'editable', delivery_receipt = NULL,
        delivery_error = NULL, claimed_at = NULL, claim_owner = NULL, settled_at = NULL,
        updated_at = ?, version = version + 1
      WHERE tenant_id = ? AND account_id = ? AND id = ? AND version = ?
        AND delivery_status IN ('editable', 'failed')
      RETURNING *
    `).get(
      content.mode,
      JSON.stringify(content.to),
      JSON.stringify(content.cc),
      JSON.stringify(content.bcc),
      content.subject,
      content.body,
      JSON.stringify(content.identity),
      content.source ? JSON.stringify(content.source) : null,
      updatedAt,
      tenantId,
      accountId,
      id,
      expectedVersion,
    ) as DraftRow | null;
    if (row) return toDraft(row);
    this.#throwDraftMutationFailure(tenantId, accountId, id, expectedVersion, "updated");
  }

  async deleteDraft(tenantId: string, accountId: string, id: string, expectedVersion: number): Promise<void> {
    const deleted = this.#sqlite.query(`
      DELETE FROM drafts
      WHERE tenant_id = ? AND account_id = ? AND id = ? AND version = ? AND delivery_status <> 'sending'
      RETURNING id
    `).get(tenantId, accountId, id, expectedVersion) as { id: string } | null;
    if (deleted) return;
    this.#throwDraftMutationFailure(tenantId, accountId, id, expectedVersion, "removed");
  }

  async claimDraftSend(
    tenantId: string,
    accountId: string,
    id: string,
    expectedVersion: number,
    claimedAt: string,
    claimOwner: string,
  ): Promise<DraftSendClaim> {
    const claim = this.#sqlite.transaction((): DraftSendClaim => {
      const current = this.#draftRow(tenantId, accountId, id);
      if (!current) throw new DraftNotFoundError();
      if (current.delivery_status === "sent") {
        const receipt = parseStoredReceipt(current.delivery_receipt);
        if (!receipt) throw new Error("Settled draft is missing its delivery receipt");
        return { kind: "sent", receipt };
      }
      if (current.version !== expectedVersion) throw new DraftConflictError();
      if (current.delivery_status === "sending") {
        throw new DraftConflictError("Draft delivery is already in progress");
      }
      if (current.delivery_status === "uncertain") {
        throw new DraftConflictError("Draft delivery is uncertain and cannot be retried automatically");
      }
      const row = this.#sqlite.query(`
        UPDATE drafts SET delivery_status = 'sending', delivery_receipt = NULL, delivery_error = NULL,
          claimed_at = ?, claim_owner = ?, settled_at = NULL, updated_at = ?, version = version + 1
        WHERE tenant_id = ? AND account_id = ? AND id = ? AND version = ?
          AND delivery_status IN ('editable', 'failed')
        RETURNING *
      `).get(claimedAt, claimOwner, claimedAt, tenantId, accountId, id, expectedVersion) as DraftRow | null;
      if (!row) throw new DraftConflictError();
      return { kind: "claimed", draft: toDraft(row) };
    });
    return claim();
  }

  async settleDraftSend(
    tenantId: string,
    accountId: string,
    id: string,
    expectedVersion: number,
    receipt: SendReceipt,
    claimOwner: string,
  ): Promise<Draft> {
    const validatedReceipt = sendReceiptSchema.parse(receipt);
    if (validatedReceipt.accountId !== accountId) {
      throw new Error("Draft delivery receipt belongs to another account");
    }
    const delivered = validatedReceipt.accepted.length > 0;
    const settledAt = validatedReceipt.submittedAt;
    const error = delivered ? null : "No recipients were accepted for delivery";
    const row = this.#sqlite.query(`
      UPDATE drafts SET delivery_status = ?, delivery_receipt = ?, delivery_error = ?,
        settled_at = ?, updated_at = ?, version = version + 1
      WHERE tenant_id = ? AND account_id = ? AND id = ? AND version = ?
        AND delivery_status = 'sending' AND claim_owner = ?
      RETURNING *
    `).get(delivered ? "sent" : "failed", JSON.stringify(validatedReceipt), error, settledAt, settledAt,
      tenantId, accountId, id, expectedVersion, claimOwner) as DraftRow | null;
    if (!row) this.#throwDraftMutationFailure(tenantId, accountId, id, expectedVersion, "settled");
    return toDraft(row);
  }

  async markDraftSendUncertain(
    tenantId: string,
    accountId: string,
    id: string,
    expectedVersion: number,
    error: string,
    failedAt: string,
    claimOwner: string,
  ): Promise<Draft> {
    const row = this.#sqlite.query(`
      UPDATE drafts SET delivery_status = 'uncertain', delivery_error = ?, settled_at = ?,
        updated_at = ?, version = version + 1
      WHERE tenant_id = ? AND account_id = ? AND id = ? AND version = ?
        AND delivery_status = 'sending' AND claim_owner = ?
      RETURNING *
    `).get(error, failedAt, failedAt, tenantId, accountId, id, expectedVersion, claimOwner) as DraftRow | null;
    if (!row) this.#throwDraftMutationFailure(tenantId, accountId, id, expectedVersion, "marked uncertain");
    return toDraft(row);
  }

  async markDraftSendFailed(
    tenantId: string,
    accountId: string,
    id: string,
    expectedVersion: number,
    error: string,
    failedAt: string,
    claimOwner: string,
  ): Promise<Draft> {
    const row = this.#sqlite.query(`
      UPDATE drafts SET delivery_status = 'failed', delivery_receipt = NULL, delivery_error = ?,
        settled_at = ?, updated_at = ?, version = version + 1
      WHERE tenant_id = ? AND account_id = ? AND id = ? AND version = ?
        AND delivery_status = 'sending' AND claim_owner = ?
      RETURNING *
    `).get(error, failedAt, failedAt, tenantId, accountId, id, expectedVersion, claimOwner) as DraftRow | null;
    if (!row) this.#throwDraftMutationFailure(tenantId, accountId, id, expectedVersion, "marked failed");
    return toDraft(row);
  }

  async recoverInterruptedDraftSends(
    tenantId: string,
    activeClaimOwner: string,
    recoveredAt: string,
  ): Promise<Draft[]> {
    const rows = this.#sqlite.query(`
      UPDATE drafts SET delivery_status = 'uncertain', delivery_receipt = NULL,
        delivery_error = 'Delivery was interrupted before its outcome could be recorded',
        settled_at = ?, updated_at = ?, version = version + 1
      WHERE tenant_id = ? AND delivery_status = 'sending'
        AND (claim_owner IS NULL OR claim_owner <> ?)
      RETURNING *
    `).all(recoveredAt, recoveredAt, tenantId, activeClaimOwner) as DraftRow[];
    return rows.map(toDraft);
  }

  async copyUncertainDraft(
    tenantId: string,
    accountId: string,
    id: string,
    expectedVersion: number,
    copyId: string,
    copiedAt: string,
  ): Promise<Draft> {
    const copy = this.#sqlite.transaction((): Draft => {
      const source = this.#sqlite.query(`
        UPDATE drafts SET updated_at = ?, version = version + 1
        WHERE tenant_id = ? AND account_id = ? AND id = ? AND version = ?
          AND delivery_status = 'uncertain'
        RETURNING *
      `).get(copiedAt, tenantId, accountId, id, expectedVersion) as DraftRow | null;
      if (!source) {
        this.#throwDraftMutationFailure(tenantId, accountId, id, expectedVersion, "copied for recovery");
      }
      this.#sqlite.query(`
        INSERT INTO drafts (
          id, tenant_id, account_id, mode, recipients_to, recipients_cc, recipients_bcc,
          subject, body, identity, source, delivery_status, delivery_receipt, delivery_error,
          claimed_at, claim_owner, settled_at, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'editable', NULL, NULL, NULL, NULL, NULL, ?, ?, 1)
      `).run(
        copyId,
        source.tenant_id,
        source.account_id,
        source.mode,
        source.recipients_to,
        source.recipients_cc,
        source.recipients_bcc,
        source.subject,
        source.body,
        source.identity,
        source.source,
        copiedAt,
        copiedAt,
      );
      const row = this.#draftRow(tenantId, accountId, copyId);
      if (!row) throw new Error("Recovery draft copy was not stored");
      return toDraft(row);
    });
    return copy();
  }

  async insertProposal(proposal: Proposal): Promise<void> {
    await this.#db.insert(proposals).values(proposal);
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const rows = await this.#db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listProposals(accountId: string): Promise<Proposal[]> {
    return this.#db.select().from(proposals)
      .where(eq(proposals.accountId, accountId))
      .orderBy(desc(proposals.updatedAt));
  }

  async updateProposal(proposal: Proposal): Promise<void> {
    await this.#db.update(proposals).set({
      title: proposal.title,
      status: proposal.status,
      items: proposal.items,
      updatedAt: proposal.updatedAt,
      approvedAt: proposal.approvedAt,
      batchId: proposal.batchId,
    }).where(eq(proposals.id, proposal.id));
  }

  async insertBatch(batch: StoredBatch): Promise<void> {
    await this.#db.insert(batches).values({
      id: batch.id,
      proposalId: batch.proposalId,
      accountId: batch.accountId,
      status: batch.status,
      operations: batch.storedOperations,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    });
  }

  async getBatch(id: string): Promise<StoredBatch | null> {
    const rows = await this.#db.select().from(batches).where(eq(batches.id, id)).limit(1);
    const row = rows[0];
    return row ? this.#toStoredBatch(row) : null;
  }

  async listBatches(accountId: string): Promise<StoredBatch[]> {
    const rows = await this.#db.select().from(batches)
      .where(eq(batches.accountId, accountId))
      .orderBy(desc(batches.createdAt));
    return rows.map((row) => this.#toStoredBatch(row));
  }

  async updateBatch(batch: StoredBatch): Promise<void> {
    await this.#db.update(batches).set({
      status: batch.status,
      operations: batch.storedOperations,
      updatedAt: batch.updatedAt,
    }).where(and(eq(batches.id, batch.id), eq(batches.accountId, batch.accountId)));
  }

  async reconcileMailbox(snapshot: MailboxSnapshot): Promise<CanonicalMessage[]> {
    for (const observation of snapshot.observations) {
      if (observation.location.providerId === "") throw new Error("Provider ID must be non-empty when present");
      if (observation.providerConversationId === "") {
        throw new Error("Provider conversation ID must be non-empty when present");
      }
      if (observation.tenantId !== snapshot.tenantId
        || observation.location.accountId !== snapshot.accountId
        || observation.location.provider !== snapshot.provider
        || observation.location.mailbox !== snapshot.mailbox) {
        throw new Error("Every observation must belong to the reconciled mailbox boundary");
      }
    }
    const reconcile = this.#sqlite.transaction((value: MailboxSnapshot) => {
      const newConversationIds = new Set<string>();
      const affectedMessageIds = new Set<string>();
      const now = new Date().toISOString();
      const observedLocationIds: string[] = [];
      let graphChanged = false;
      for (const observation of value.observations) {
        const observedReceivedAt = observation.receivedAt ?? null;
        const normalizedMessageId = normalizeMessageId(observation.messageId);
        const normalizedInReplyToIds = normalizeMessageIdList(observation.inReplyTo);
        const normalizedInReplyTo = normalizedInReplyToIds.length > 0 ? normalizedInReplyToIds.join(" ") : null;
        const normalizedReferences = normalizeMessageIdLists(observation.references);
        const locationKey = locationKeyFor(observation);
        const legacyLocationKey = legacyLocationKeyFor(observation);
        const fallbackIdentityKey = fallbackIdentityKeyFor(observation);
        const legacyFallbackIdentityKey = legacyFallbackIdentityKeyFor(this.#sqlite, observation);
        const providerCanonical = findProviderCanonical(this.#sqlite, observation);
        let canonical: MessageRow | null = null;
        let fallbackRows: MessageRow[] = [];
        let canonicalCreated = false;

        if (normalizedMessageId) {
          const identityKey = `message-id:${normalizedMessageId}`;
          canonical = this.#sqlite.query(
            "SELECT * FROM messages WHERE tenant_id = ? AND identity_key = ?",
          ).get(value.tenantId, identityKey) as MessageRow | null;
          fallbackRows = this.#sqlite.query(`
            SELECT DISTINCT message.*
            FROM messages message
            LEFT JOIN message_locations location
              ON location.tenant_id = message.tenant_id AND location.message_id = message.id
            WHERE message.tenant_id = ? AND message.message_id IS NULL
              AND (message.identity_key = ? OR (message.identity_key = ?
                AND NOT EXISTS (
                  SELECT 1 FROM message_provider_associations known_association
                  WHERE known_association.tenant_id = message.tenant_id
                    AND known_association.message_id = message.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM message_locations known_location
                  WHERE known_location.tenant_id = message.tenant_id
                    AND known_location.message_id = message.id
                )
              ) OR (
                location.account_id = ? AND location.provider = ? AND location.location_key IN (?, ?)
              ) OR EXISTS (
                SELECT 1 FROM message_provider_associations association
                WHERE association.tenant_id = message.tenant_id AND association.message_id = message.id
                  AND association.account_id = ? AND association.provider = ?
                  AND ((? IS NOT NULL AND association.provider_id = ?)
                    OR (? IS NULL AND association.provider_id IS NULL AND association.mailbox = ?
                      AND association.uid_validity = ? AND association.uid = ?))
              ))
            ORDER BY message.created_at, message.id
          `).all(value.tenantId, fallbackIdentityKey, legacyFallbackIdentityKey,
            value.accountId, value.provider, locationKey, legacyLocationKey,
            value.accountId, value.provider, observation.location.providerId, observation.location.providerId,
            observation.location.providerId, observation.location.mailbox, observation.location.uidValidity,
            observation.location.uid) as MessageRow[];
          canonical ??= fallbackRows[0] ?? null;
          if (!canonical) {
            const id = crypto.randomUUID();
            this.#sqlite.query(`
              INSERT INTO messages
                (id, tenant_id, identity_key, message_id, in_reply_to, "references", received_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, value.tenantId, identityKey, normalizedMessageId, normalizedInReplyTo,
              JSON.stringify(normalizedReferences), observedReceivedAt, now, now);
            canonical = this.#sqlite.query("SELECT * FROM messages WHERE tenant_id = ? AND id = ?")
              .get(value.tenantId, id) as MessageRow;
            canonicalCreated = true;
          }

          const observedReferenceSequences = normalizedReferenceSequences(observation, normalizedReferences);
          associateReferenceSequences(this.#sqlite, value.tenantId, canonical.id, observedReferenceSequences);
          const mergedMetadata = mergeThreadingMetadata(
            normalizedInReplyTo, normalizedReferences, toThreadingMetadata(this.#sqlite, canonical),
            fallbackRows.map((row) => toThreadingMetadata(this.#sqlite, row)),
            observedReferenceSequences,
          );
          const receivedAt = earliestReceivedAt(observedReceivedAt, canonical, fallbackRows);
          const promotedMessageId = canonical.message_id === null;
          this.#sqlite.query(`
            UPDATE messages SET identity_key = ?, message_id = ?, in_reply_to = ?, "references" = ?,
              received_at = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?
          `).run(identityKey, normalizedMessageId, mergedMetadata.inReplyTo,
            JSON.stringify(mergedMetadata.references), receivedAt, now, value.tenantId, canonical.id);
          for (const fallback of fallbackRows) {
            if (fallback.id === canonical.id) continue;
            graphChanged = true;
            affectedMessageIds.add(canonical.id);
            mergeCanonicalMessages(this.#sqlite, value.tenantId, canonical.id, fallback.id, now);
          }
          if (promotedMessageId) {
            graphChanged = true;
            affectedMessageIds.add(canonical.id);
            newConversationIds.add(canonical.id);
          }
        } else {
          canonical = providerCanonical;
          canonical ??= this.#sqlite.query(`
            SELECT * FROM messages
            WHERE tenant_id = ? AND message_id IS NULL AND (identity_key = ? OR (identity_key = ?
              AND NOT EXISTS (
                SELECT 1 FROM message_provider_associations association
                WHERE association.tenant_id = messages.tenant_id AND association.message_id = messages.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM message_locations location
                WHERE location.tenant_id = messages.tenant_id AND location.message_id = messages.id
              )
            ))
            ORDER BY CASE WHEN identity_key = ? THEN 0 ELSE 1 END, created_at, id
            LIMIT 1
          `).get(value.tenantId, fallbackIdentityKey, legacyFallbackIdentityKey, fallbackIdentityKey) as MessageRow | null;
          if (!canonical) {
            const id = crypto.randomUUID();
            this.#sqlite.query(`
              INSERT INTO messages
                (id, tenant_id, identity_key, message_id, in_reply_to, "references", received_at, created_at, updated_at)
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
              ON CONFLICT (tenant_id, identity_key) DO NOTHING
            `).run(id, value.tenantId, fallbackIdentityKey, normalizedInReplyTo,
              JSON.stringify(normalizedReferences), observedReceivedAt, now, now);
            canonical = this.#sqlite.query(
              "SELECT * FROM messages WHERE tenant_id = ? AND identity_key = ?",
            ).get(value.tenantId, fallbackIdentityKey) as MessageRow;
            canonicalCreated = canonical.id === id;
          }
          const observedReferenceSequences = normalizedReferenceSequences(observation, normalizedReferences);
          associateReferenceSequences(this.#sqlite, value.tenantId, canonical.id, observedReferenceSequences);
          const mergedMetadata = mergeThreadingMetadata(
            normalizedInReplyTo, normalizedReferences, toThreadingMetadata(this.#sqlite, canonical), [],
            observedReferenceSequences,
          );
          const receivedAt = earliestReceivedAt(observedReceivedAt, canonical, []);
          this.#sqlite.query(`
            UPDATE messages SET in_reply_to = ?, "references" = ?, received_at = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?
          `).run(mergedMetadata.inReplyTo, JSON.stringify(mergedMetadata.references), receivedAt, now,
            value.tenantId, canonical.id);
        }

        const canonicalId = canonical.id;
        ensureMessageConversation(this.#sqlite, canonical);
        if (canonicalCreated) newConversationIds.add(canonical.id);
        const threadChanged = associateThreadEdges(this.#sqlite, value.tenantId, canonicalId,
          [...normalizedInReplyToIds, ...normalizedReferences]);
        if (threadChanged || (canonicalCreated && normalizedMessageId)) {
          graphChanged = true;
          affectedMessageIds.add(canonicalId);
        }
        associateProviderObservation(this.#sqlite, observation, canonicalId);
        if (observation.providerConversationId) {
          if (associateProviderConversation(this.#sqlite, observation, canonicalId)) {
            graphChanged = true;
            affectedMessageIds.add(canonicalId);
          }
        }
        const existingLocation = this.#sqlite.query(`
          SELECT id FROM message_locations
          WHERE tenant_id = ? AND account_id = ? AND provider = ? AND mailbox = ?
            AND location_key IN (?, ?)
          ORDER BY CASE WHEN location_key = ? THEN 0 ELSE 1 END, id
          LIMIT 1
        `).get(value.tenantId, value.accountId, value.provider, value.mailbox,
          locationKey, legacyLocationKey, locationKey) as { id: string } | null;
        const location = existingLocation
          ? this.#sqlite.query(`
              UPDATE message_locations SET
                message_id = ?, uid_validity = ?, uid = ?, modseq = ?, provider_id = ?,
                read = ?, flagged = ?, observed_at = ?
              WHERE id = ?
              RETURNING id
            `).get(canonicalId, observation.location.uidValidity, observation.location.uid,
              observation.location.modseq, observation.location.providerId,
              observation.location.read ? 1 : 0, observation.location.flagged ? 1 : 0,
              now, existingLocation.id) as { id: string }
          : this.#sqlite.query(`
              INSERT INTO message_locations
                (id, message_id, tenant_id, account_id, provider, mailbox, location_key, uid_validity, uid,
                  modseq, provider_id, read, flagged, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING id
            `).get(crypto.randomUUID(), canonicalId, value.tenantId, value.accountId, value.provider,
              value.mailbox, locationKey, observation.location.uidValidity, observation.location.uid,
              observation.location.modseq, observation.location.providerId,
              observation.location.read ? 1 : 0, observation.location.flagged ? 1 : 0, now) as { id: string };
        const locationId = location.id;
        observedLocationIds.push(locationId);
      }
      if (value.authoritative) {
        const locations = this.#sqlite.query(
          "SELECT id FROM message_locations WHERE tenant_id = ? AND account_id = ? AND provider = ? AND mailbox = ?",
        ).all(value.tenantId, value.accountId, value.provider, value.mailbox) as Array<{ id: string }>;
        const retained = new Set(observedLocationIds);
        const remove = this.#sqlite.query("DELETE FROM message_locations WHERE id = ?");
        for (const location of locations) if (!retained.has(location.id)) remove.run(location.id);
      }
      if (graphChanged) this.#repairConversations(value.tenantId, newConversationIds, affectedMessageIds);
      return observedLocationIds.map((id) => {
        const location = this.#sqlite.query(
          "SELECT message_id FROM message_locations WHERE tenant_id = ? AND id = ?",
        ).get(value.tenantId, id) as { message_id: string } | null;
        if (!location) throw new Error("Reconciled message location is missing");
        const message = this.#getMessage(value.tenantId, location.message_id);
        if (!message) throw new Error("Reconciled canonical message is missing");
        return message;
      });
    });
    return reconcile(snapshot);
  }

  async recordProviderMove(
    tenantId: string,
    provider: MailProviderKind,
    previous: MessageRef,
    current: MessageRef,
  ): Promise<boolean> {
    if (!tenantId.trim()) throw new Error("A tenant ID is required");
    if (previous.accountId !== current.accountId) throw new Error("Provider moves cannot cross accounts");
    if (previous.providerId === "" || current.providerId === "") {
      throw new Error("Provider ID must be non-empty when present");
    }
    const account = this.#sqlite.query("SELECT kind FROM accounts WHERE id = ?").get(previous.accountId) as {
      kind: MailProviderKind;
    } | null;
    if (!account || account.kind !== provider) throw new Error("Provider move account boundary is invalid");

    const record = this.#sqlite.transaction(() => {
      const source = findCanonicalForReference(this.#sqlite, tenantId, provider, previous);
      if (!source) return false;
      const destination = findCanonicalForReference(this.#sqlite, tenantId, provider, current);
      let canonical = source;

      let mergedMessages = false;
      if (destination && destination.id !== source.id) {
        if (source.message_id && destination.message_id && source.message_id !== destination.message_id) {
          throw new Error("Provider move conflicts with a different canonical Message-ID");
        }
        const merged = destination.message_id && !source.message_id ? source : destination;
        canonical = merged.id === source.id ? destination : source;
        const now = new Date().toISOString();
        const metadata = mergeThreadingMetadata(
          null, [], toThreadingMetadata(this.#sqlite, canonical), [toThreadingMetadata(this.#sqlite, merged)],
        );
        const receivedAt = earliestReceivedAt(null, canonical, [merged]);
        this.#sqlite.query(`
          UPDATE messages SET in_reply_to = ?, "references" = ?, received_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?
        `).run(metadata.inReplyTo, JSON.stringify(metadata.references), receivedAt, now, tenantId, canonical.id);
        mergeCanonicalMessages(this.#sqlite, tenantId, canonical.id, merged.id, now);
        mergedMessages = true;
      }

      associateProviderReference(this.#sqlite, tenantId, provider, previous, canonical.id);
      associateProviderReference(this.#sqlite, tenantId, provider, current, canonical.id);
      if (mergedMessages) this.#repairConversations(tenantId, new Set(), new Set([canonical.id]));
      return true;
    });
    return record();
  }

  async getMessage(tenantId: string, id: string): Promise<CanonicalMessage | null> {
    return this.#getMessage(tenantId, id);
  }

  async getConversation(tenantId: string, id: string): Promise<CanonicalConversation | null> {
    const conversation = this.#sqlite.query(`
      SELECT conversation.* FROM conversations conversation
      LEFT JOIN conversation_aliases alias
        ON alias.tenant_id = conversation.tenant_id AND alias.conversation_id = conversation.id
      WHERE conversation.tenant_id = ? AND (conversation.id = ? OR alias.alias_id = ?)
      ORDER BY CASE WHEN conversation.id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(tenantId, id, id, id) as ConversationRow | null;
    if (!conversation) return null;
    const rows = this.#sqlite.query(`
      SELECT message.* FROM conversation_messages membership
      INNER JOIN messages message
        ON message.tenant_id = membership.tenant_id AND message.id = membership.message_id
      WHERE membership.tenant_id = ? AND membership.conversation_id = ?
    `).all(tenantId, conversation.id) as MessageRow[];
    const threadingRows = this.#sqlite.query(`
      SELECT edge.message_id, edge.referenced_message_id,
        NULL AS sequence_key, NULL AS position
      FROM message_thread_edges edge
      INNER JOIN conversation_messages membership
        ON membership.tenant_id = edge.tenant_id AND membership.message_id = edge.message_id
      WHERE membership.tenant_id = ? AND membership.conversation_id = ?
      UNION ALL
      SELECT sequence.message_id, sequence.referenced_message_id,
        sequence.sequence_key, sequence.position
      FROM message_reference_sequences sequence
      INNER JOIN conversation_messages membership
        ON membership.tenant_id = sequence.tenant_id AND membership.message_id = sequence.message_id
      WHERE membership.tenant_id = ? AND membership.conversation_id = ?
    `).all(tenantId, conversation.id, tenantId, conversation.id) as Array<{
      message_id: string;
      referenced_message_id: string | null;
      sequence_key: string | null;
      position: number | null;
    }>;
    const edgesByMessage = new Map<string, string[]>();
    const sequencesByMessage = new Map<string, Map<string, string[]>>();
    for (const row of threadingRows) {
      if (row.sequence_key === null && row.referenced_message_id !== null) {
        const edges = edgesByMessage.get(row.message_id) ?? [];
        edges.push(row.referenced_message_id);
        edgesByMessage.set(row.message_id, edges);
      }
      if (row.sequence_key !== null && row.position !== null && row.referenced_message_id !== null) {
        const sequences = sequencesByMessage.get(row.message_id) ?? new Map<string, string[]>();
        const sequence = sequences.get(row.sequence_key) ?? [];
        sequence[row.position] = row.referenced_message_id;
        sequences.set(row.sequence_key, sequence);
        sequencesByMessage.set(row.message_id, sequences);
      }
    }
    const orderedIds = orderConversationMessages(rows.map((row) =>
      toConversationMessageForOrder(row, edgesByMessage.get(row.id),
        [...(sequencesByMessage.get(row.id)?.values() ?? [])])))
      .map(({ id }) => id);
    const messageAliasRows = this.#sqlite.query(`
      SELECT alias.message_id, alias.alias_id
      FROM conversation_messages membership INDEXED BY conversation_messages_conversation_id_idx
      INNER JOIN message_aliases alias INDEXED BY message_aliases_message_id_idx
        ON alias.tenant_id = membership.tenant_id AND alias.message_id = membership.message_id
      WHERE membership.tenant_id = ? AND membership.conversation_id = ?
      ORDER BY alias.message_id, alias.created_at, alias.alias_id
    `).all(tenantId, conversation.id) as Array<{ message_id: string; alias_id: string }>;
    const aliasesByMessage = new Map<string, string[]>();
    for (const alias of messageAliasRows) {
      const messageAliases = aliasesByMessage.get(alias.message_id) ?? [];
      messageAliases.push(alias.alias_id);
      aliasesByMessage.set(alias.message_id, messageAliases);
    }
    const messageById = new Map(rows.map((row) => [row.id, row]));
    const aliases = this.#sqlite.query(`
      SELECT alias_id FROM conversation_aliases
      WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at, alias_id
    `).all(tenantId, conversation.id) as Array<{ alias_id: string }>;
    return {
      id: conversation.id,
      aliases: aliases.map(({ alias_id }) => alias_id),
      tenantId: conversation.tenant_id,
      messages: orderedIds.map((messageId) => {
        const message = messageById.get(messageId);
        if (!message) throw new Error("Conversation contains a missing canonical message");
        return toCanonicalMessage(message, conversation.id, aliasesByMessage.get(messageId) ?? []);
      }),
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
    };
  }

  async listMessageLocations(tenantId: string, messageId: string): Promise<StoredMessageLocation[]> {
    const message = this.#getMessage(tenantId, messageId);
    if (!message) return [];
    const rows = this.#sqlite.query("SELECT * FROM message_locations WHERE tenant_id = ? AND message_id = ? ORDER BY account_id, mailbox, id")
      .all(tenantId, message.id) as LocationRow[];
    return rows.map(toStoredLocation);
  }

  async hasMessageProviderAssociation(
    tenantId: string,
    messageId: string,
    accountId: string,
    provider: MailProviderKind,
  ): Promise<boolean> {
    const message = this.#getMessage(tenantId, messageId);
    if (!message) return false;
    const association = this.#sqlite.query(`
      SELECT 1 FROM message_provider_associations
      WHERE tenant_id = ? AND message_id = ? AND account_id = ? AND provider = ?
      LIMIT 1
    `).get(tenantId, message.id, accountId, provider);
    return association !== null;
  }

  async getProviderConversationId(
    tenantId: string,
    messageId: string,
    accountId: string,
    provider: MailProviderKind,
    preferredId?: string,
  ): Promise<string | null> {
    const message = this.#getMessage(tenantId, messageId);
    if (!message) return null;
    const rows = this.#sqlite.query(`
      SELECT provider_conversation_id FROM message_provider_conversations
      WHERE tenant_id = ? AND message_id = ? AND account_id = ? AND provider = ?
      ORDER BY provider_conversation_id
    `).all(tenantId, message.id, accountId, provider) as Array<{ provider_conversation_id: string }>;
    if (preferredId) {
      if (rows.some(({ provider_conversation_id }) => provider_conversation_id === preferredId)) return preferredId;
      throw new Error("The selected provider conversation no longer belongs to the source message");
    }
    if (rows.length > 1) throw new Error("The source message has multiple provider conversations; select a specific source location");
    return rows[0]?.provider_conversation_id ?? null;
  }

  async recordConversationSend(
    tenantId: string,
    accountId: string,
    provider: MailProviderKind,
    receipt: SendReceipt,
    context: ConversationSendContext,
  ): Promise<CanonicalMessage> {
    const record = this.#sqlite.transaction(() => {
      const now = receipt.submittedAt;
      const identityKey = `message-id:${receipt.messageId}`;
      let row = this.#sqlite.query("SELECT * FROM messages WHERE tenant_id = ? AND identity_key = ?")
        .get(tenantId, identityKey) as MessageRow | null;
      const created = row === null;
      if (!row) {
        const id = crypto.randomUUID();
        const reply = context.type === "reply" || context.type === "reply_all" ? context : undefined;
        this.#sqlite.query(`
          INSERT INTO messages
            (id, tenant_id, identity_key, message_id, in_reply_to, "references", received_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, tenantId, identityKey, receipt.messageId, reply?.inReplyTo ?? null,
          JSON.stringify(reply?.references ?? []), now, now, now);
        row = this.#sqlite.query("SELECT * FROM messages WHERE tenant_id = ? AND id = ?")
          .get(tenantId, id) as MessageRow;
      }

      if (context.type === "reply" || context.type === "reply_all") {
        if (created) {
          this.#sqlite.query(`
            INSERT INTO conversation_messages (tenant_id, conversation_id, message_id) VALUES (?, ?, ?)
          `).run(tenantId, context.conversationId, row.id);
        } else {
          ensureMessageConversation(this.#sqlite, row);
        }
        associateThreadEdges(this.#sqlite, tenantId, row.id, [context.inReplyTo ?? null, ...context.references]);
        associateReferenceSequences(this.#sqlite, tenantId, row.id, [context.references]);
        if (provider === "gmail" && receipt.providerConversationId) {
          this.#sqlite.query(`
            INSERT OR IGNORE INTO message_provider_conversations
              (tenant_id, account_id, provider, provider_conversation_id, message_id)
            VALUES (?, ?, ?, ?, ?)
          `).run(tenantId, accountId, provider, receipt.providerConversationId, row.id);
        }
        this.#repairConversations(
          tenantId,
          created ? new Set([row.id]) : new Set(),
          new Set([context.sourceMessageId, row.id]),
        );
      } else {
        ensureMessageConversation(this.#sqlite, row);
      }
      const stored = this.#getMessage(tenantId, row.id);
      if (!stored) throw new Error("Sent canonical message was not recorded");
      return stored;
    });
    return record();
  }

  #getMessage(tenantId: string, id: string): CanonicalMessage | null {
    const row = this.#sqlite.query(`
      SELECT message.*
      FROM messages message
      LEFT JOIN message_aliases alias
        ON alias.tenant_id = message.tenant_id AND alias.message_id = message.id
      WHERE message.tenant_id = ? AND (message.id = ? OR alias.alias_id = ?)
      LIMIT 1
    `).get(tenantId, id, id) as MessageRow | null;
    const aliases = row
      ? this.#sqlite.query("SELECT alias_id FROM message_aliases WHERE tenant_id = ? AND message_id = ? ORDER BY created_at, alias_id")
        .all(tenantId, row.id) as Array<{ alias_id: string }>
      : [];
    const membership = row ? this.#sqlite.query(`
      SELECT conversation_id FROM conversation_messages WHERE tenant_id = ? AND message_id = ?
    `).get(tenantId, row.id) as { conversation_id: string } | null : null;
    if (row && !membership) throw new Error("Canonical message conversation is missing");
    return row
      ? toCanonicalMessage(row, membership!.conversation_id, aliases.map(({ alias_id }) => alias_id))
      : null;
  }

  #draftRow(tenantId: string, accountId: string, id: string): DraftRow | null {
    return this.#sqlite.query("SELECT * FROM drafts WHERE tenant_id = ? AND account_id = ? AND id = ?")
      .get(tenantId, accountId, id) as DraftRow | null;
  }

  #throwDraftMutationFailure(
    tenantId: string,
    accountId: string,
    id: string,
    expectedVersion: number,
    operation: string,
  ): never {
    const row = this.#draftRow(tenantId, accountId, id);
    if (!row) throw new DraftNotFoundError();
    if (row.version !== expectedVersion) throw new DraftConflictError();
    throw new DraftConflictError(`Draft cannot be ${operation} while delivery is ${row.delivery_status}`);
  }

  #toStoredBatch(row: typeof batches.$inferSelect): StoredBatch {
    return {
      id: row.id,
      proposalId: row.proposalId,
      accountId: row.accountId,
      status: row.status,
      operations: row.operations.map(({ result }) => result),
      storedOperations: row.operations,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #repairConversations(
    tenantId: string,
    newConversationIds: ReadonlySet<string> = new Set(),
    affectedMessageIds?: ReadonlySet<string>,
  ): void {
    repairConversations(this.#sqlite, tenantId, newConversationIds, affectedMessageIds);
  }

  #migrate(): void {
    this.#sqlite.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')),
        encrypted_credentials TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        batch_id TEXT
      );
      CREATE TABLE IF NOT EXISTS operation_batches (
        id TEXT PRIMARY KEY NOT NULL,
        proposal_id TEXT NOT NULL REFERENCES proposals(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        status TEXT NOT NULL,
        operations TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        message_id TEXT,
        in_reply_to TEXT,
        "references" TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, identity_key),
        UNIQUE (tenant_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_id_id_unique ON messages(tenant_id, id);
      CREATE TABLE IF NOT EXISTS message_aliases (
        alias_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, alias_id),
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS message_locations (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail')),
        mailbox TEXT NOT NULL,
        location_key TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        uid INTEGER NOT NULL,
        modseq TEXT,
        provider_id TEXT,
        read INTEGER NOT NULL,
        flagged INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      CREATE INDEX IF NOT EXISTS proposals_account_id_idx ON proposals(account_id);
      CREATE INDEX IF NOT EXISTS batches_account_id_idx ON operation_batches(account_id);
      CREATE INDEX IF NOT EXISTS message_locations_message_id_idx ON message_locations(message_id);
      CREATE INDEX IF NOT EXISTS message_aliases_message_id_idx ON message_aliases(message_id);
    `);
    this.#migrateMessageLocationTenantForeignKey();
    this.#migrateMessageProviderAssociations();
    this.#migrateConversations();
    this.#migrateReferenceSequences();
    this.#migrateSemanticMessageIds();
    this.#migrateDrafts();
    const accountsTable = this.#sqlite.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
      .get() as { sql: string } | null;
    if (accountsTable && !accountsTable.sql.includes("'gmail'")) {
      this.#sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.#sqlite.exec(`
          BEGIN;
          CREATE TABLE accounts_with_gmail (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')),
            encrypted_credentials TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO accounts_with_gmail
            SELECT id, name, email, kind, encrypted_credentials, created_at
            FROM accounts
            WHERE kind IN ('imap', 'gmail');
          DROP TABLE accounts;
          ALTER TABLE accounts_with_gmail RENAME TO accounts;
          COMMIT;
        `);
      } catch (error) {
        if (this.#sqlite.inTransaction) this.#sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        this.#sqlite.exec("PRAGMA foreign_keys = ON");
      }
    }
    this.#sqlite.exec(`
      DELETE FROM operation_batches
      WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'fixture');
      DELETE FROM proposals
      WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'fixture');
      DELETE FROM accounts WHERE kind = 'fixture';
    `);
  }

  #migrateDrafts(): void {
    if (this.#sqlite.query("SELECT 1 FROM schema_migrations WHERE version = 479").get()) return;
    const migrate = this.#sqlite.transaction(() => {
      this.#sqlite.exec(`
        CREATE TABLE drafts (
          id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          mode TEXT NOT NULL CHECK (mode IN ('new', 'reply', 'reply_all', 'forward')),
          recipients_to TEXT NOT NULL,
          recipients_cc TEXT NOT NULL,
          recipients_bcc TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          identity TEXT NOT NULL,
          source TEXT,
          delivery_status TEXT NOT NULL CHECK (delivery_status IN ('editable', 'sending', 'failed', 'uncertain', 'sent')),
          delivery_receipt TEXT,
          delivery_error TEXT,
          claimed_at TEXT,
          claim_owner TEXT,
          settled_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          PRIMARY KEY (tenant_id, id),
          CHECK (
            (delivery_status = 'editable' AND delivery_receipt IS NULL
              AND delivery_error IS NULL AND claimed_at IS NULL
              AND claim_owner IS NULL AND settled_at IS NULL)
            OR (delivery_status = 'sending' AND delivery_receipt IS NULL
              AND delivery_error IS NULL AND claimed_at IS NOT NULL
              AND claim_owner IS NOT NULL AND settled_at IS NULL)
            OR (delivery_status = 'failed'
              AND delivery_error IS NOT NULL AND claimed_at IS NOT NULL
              AND claim_owner IS NOT NULL AND settled_at IS NOT NULL)
            OR (delivery_status = 'uncertain' AND delivery_receipt IS NULL
              AND delivery_error IS NOT NULL AND claimed_at IS NOT NULL
              AND claim_owner IS NOT NULL AND settled_at IS NOT NULL)
            OR (delivery_status = 'sent' AND delivery_receipt IS NOT NULL
              AND delivery_error IS NULL AND claimed_at IS NOT NULL
              AND claim_owner IS NOT NULL AND settled_at IS NOT NULL)
          )
        );
        CREATE INDEX drafts_tenant_account_updated_idx ON drafts(tenant_id, account_id, updated_at);
        INSERT INTO schema_migrations (version, applied_at) VALUES (479, CURRENT_TIMESTAMP);
      `);
      const violations = this.#sqlite.query("PRAGMA foreign_key_check('drafts')").all();
      if (violations.length > 0) throw new Error("Draft migration left invalid foreign keys");
    });
    migrate();
  }

  #migrateMessageLocationTenantForeignKey(): void {
    this.#sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_id_id_unique ON messages(tenant_id, id)");
    const foreignKeys = this.#sqlite.query("PRAGMA foreign_key_list('message_locations')").all() as Array<{
      id: number;
      table: string;
      from: string;
      to: string;
    }>;
    const messageForeignKeys = new Map<number, typeof foreignKeys>();
    for (const foreignKey of foreignKeys.filter((candidate) => candidate.table === "messages")) {
      const columns = messageForeignKeys.get(foreignKey.id) ?? [];
      columns.push(foreignKey);
      messageForeignKeys.set(foreignKey.id, columns);
    }
    const hasTenantMessageForeignKey = [...messageForeignKeys.values()].some((columns) =>
      columns.some((column) => column.from === "tenant_id" && column.to === "tenant_id")
      && columns.some((column) => column.from === "message_id" && column.to === "id"));
    if (!hasTenantMessageForeignKey) {
      this.#sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.#sqlite.exec(`
          BEGIN;
          CREATE TABLE message_locations_with_tenant_fk (
            id TEXT PRIMARY KEY NOT NULL,
            message_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail')),
            mailbox TEXT NOT NULL,
            location_key TEXT NOT NULL,
            uid_validity TEXT NOT NULL,
            uid INTEGER NOT NULL,
            modseq TEXT,
            provider_id TEXT,
            read INTEGER NOT NULL,
            flagged INTEGER NOT NULL,
            observed_at TEXT NOT NULL,
            FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
            UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
          );
          INSERT INTO message_locations_with_tenant_fk
            (id, message_id, tenant_id, account_id, provider, mailbox, location_key,
              uid_validity, uid, modseq, provider_id, read, flagged, observed_at)
          SELECT id, message_id, tenant_id, account_id, provider, mailbox, location_key,
            uid_validity, uid, modseq, provider_id, read, flagged, observed_at
          FROM message_locations;
          DROP TABLE message_locations;
          ALTER TABLE message_locations_with_tenant_fk RENAME TO message_locations;
          INSERT OR IGNORE INTO schema_migrations (version, applied_at)
            VALUES (476, CURRENT_TIMESTAMP);
        `);
        const violations = this.#sqlite.query("PRAGMA foreign_key_check('message_locations')").all();
        if (violations.length > 0) throw new Error("Canonical message migration left invalid foreign keys");
        this.#sqlite.exec("COMMIT");
      } catch (error) {
        if (this.#sqlite.inTransaction) this.#sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        this.#sqlite.exec("PRAGMA foreign_keys = ON");
      }
    }
    this.#sqlite.exec("CREATE INDEX IF NOT EXISTS message_locations_message_id_idx ON message_locations(message_id)");
  }

  #migrateMessageProviderAssociations(): void {
    const applied = this.#sqlite.query("SELECT 1 FROM schema_migrations WHERE version = 476001").get();
    if (applied) return;
    const migrate = this.#sqlite.transaction(() => {
      this.#sqlite.exec(`
        CREATE TABLE message_provider_associations (
          tenant_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail')),
          provider_id TEXT,
          mailbox TEXT,
          uid_validity TEXT,
          uid INTEGER,
          message_id TEXT NOT NULL,
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
          CHECK ((provider_id IS NOT NULL AND provider_id <> ''
              AND mailbox IS NULL AND uid_validity IS NULL AND uid IS NULL)
            OR (provider_id IS NULL AND mailbox IS NOT NULL AND uid_validity IS NOT NULL AND uid IS NOT NULL))
        );
        CREATE UNIQUE INDEX message_provider_associations_provider_id_unique
          ON message_provider_associations(tenant_id, account_id, provider, provider_id)
          WHERE provider_id IS NOT NULL;
        CREATE UNIQUE INDEX message_provider_associations_location_unique
          ON message_provider_associations(tenant_id, account_id, provider, mailbox, uid_validity, uid)
          WHERE provider_id IS NULL;
        CREATE INDEX message_provider_associations_message_id_idx
          ON message_provider_associations(message_id);
      `);
      const providerConflict = this.#sqlite.query(`
        SELECT 1 FROM message_locations
        WHERE provider_id IS NOT NULL AND provider_id <> ''
        GROUP BY tenant_id, account_id, provider, provider_id
        HAVING COUNT(DISTINCT message_id) > 1
        LIMIT 1
      `).get();
      const locationConflict = this.#sqlite.query(`
        SELECT 1 FROM message_locations
        WHERE provider_id IS NULL OR provider_id = ''
        GROUP BY tenant_id, account_id, provider, mailbox, uid_validity, uid
        HAVING COUNT(DISTINCT message_id) > 1
        LIMIT 1
      `).get();
      if (providerConflict || locationConflict) {
        throw new Error("Canonical provider association migration found conflicting messages");
      }
      this.#sqlite.exec(`
        INSERT INTO message_provider_associations
          (tenant_id, account_id, provider, provider_id, mailbox, uid_validity, uid, message_id)
        SELECT tenant_id, account_id, provider, NULLIF(provider_id, ''),
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN mailbox ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid_validity ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid ELSE NULL END,
          MIN(message_id)
        FROM message_locations
        GROUP BY tenant_id, account_id, provider, NULLIF(provider_id, ''),
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN mailbox ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid_validity ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid ELSE NULL END;
        INSERT INTO schema_migrations (version, applied_at) VALUES (476001, CURRENT_TIMESTAMP);
      `);
      const violations = this.#sqlite.query("PRAGMA foreign_key_check('message_provider_associations')").all();
      if (violations.length > 0) throw new Error("Canonical provider association migration left invalid foreign keys");
    });
    migrate();
  }

  #migrateConversations(): void {
    if (this.#sqlite.query("SELECT 1 FROM schema_migrations WHERE version = 477").get()) {
      const incomplete = this.#sqlite.query(`
        SELECT 1 FROM messages message
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_messages membership
          WHERE membership.tenant_id = message.tenant_id AND membership.message_id = message.id
        ) OR EXISTS (
          SELECT 1 FROM json_each(message."references") reference
          WHERE NOT EXISTS (
            SELECT 1 FROM message_thread_edges edge
            WHERE edge.tenant_id = message.tenant_id AND edge.message_id = message.id
              AND edge.referenced_message_id = reference.value
          )
        )
        LIMIT 1
      `).get();
      const storedEdges = new Set((this.#sqlite.query(`
        SELECT tenant_id, message_id, referenced_message_id FROM message_thread_edges
      `).all() as Array<{ tenant_id: string; message_id: string; referenced_message_id: string }>)
        .map(({ tenant_id, message_id, referenced_message_id }) =>
          JSON.stringify([tenant_id, message_id, referenced_message_id])));
      const missingInReplyToEdge = (this.#sqlite.query(`
        SELECT tenant_id, id, in_reply_to FROM messages WHERE in_reply_to IS NOT NULL
      `).all() as Array<{ tenant_id: string; id: string; in_reply_to: string }>)
        .some(({ tenant_id, id, in_reply_to }) => normalizeMessageIdList(in_reply_to)
          .some((parentId) => !storedEdges.has(JSON.stringify([tenant_id, id, parentId]))));
      const liveAlias = this.#sqlite.query(`
        SELECT 1 FROM conversation_aliases alias
        INNER JOIN conversations conversation
          ON conversation.tenant_id = alias.tenant_id AND conversation.id = alias.alias_id
        LIMIT 1
      `).get();
      if (!incomplete && !missingInReplyToEdge && !liveAlias) return;
      const recover = this.#sqlite.transaction(() => this.#recoverConversations());
      recover();
      return;
    }
    const migrate = this.#sqlite.transaction(() => {
      const messageColumns = this.#sqlite.query("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
      if (!messageColumns.some(({ name }) => name === "received_at")) {
        this.#sqlite.exec("ALTER TABLE messages ADD COLUMN received_at TEXT");
      }
      this.#sqlite.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY NOT NULL,
          tenant_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (tenant_id, id)
        );
        CREATE TABLE conversation_messages (
          tenant_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, message_id),
          FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
        );
        CREATE TABLE conversation_aliases (
          alias_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, alias_id),
          FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id)
        );
        CREATE TABLE message_provider_conversations (
          tenant_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail')),
          provider_conversation_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, account_id, provider, provider_conversation_id, message_id),
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
        );
        CREATE TABLE message_thread_edges (
          tenant_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          referenced_message_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, message_id, referenced_message_id),
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
        );
        CREATE INDEX conversation_messages_conversation_id_idx ON conversation_messages(conversation_id);
        CREATE INDEX conversation_aliases_conversation_id_idx ON conversation_aliases(conversation_id);
        CREATE INDEX messages_tenant_id_message_id_idx ON messages(tenant_id, message_id);
        CREATE INDEX message_provider_conversations_message_id_idx ON message_provider_conversations(message_id);
        CREATE INDEX message_thread_edges_reference_idx
          ON message_thread_edges(tenant_id, referenced_message_id);
      `);
      const messages = this.#sqlite.query("SELECT * FROM messages ORDER BY tenant_id, identity_key")
        .all() as MessageRow[];
      for (const message of messages) {
        ensureMessageConversation(this.#sqlite, message);
        associateThreadEdges(this.#sqlite, message.tenant_id, message.id,
          [...normalizeMessageIdList(message.in_reply_to), ...parseStoredReferences(message.references)]);
      }
      const tenants = [...new Set(messages.map(({ tenant_id }) => tenant_id))];
      for (const tenantId of tenants) repairConversations(this.#sqlite, tenantId, new Set());
      const missingMembership = this.#sqlite.query(`
        SELECT 1 FROM messages message
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_messages membership
          WHERE membership.tenant_id = message.tenant_id AND membership.message_id = message.id
        ) LIMIT 1
      `).get();
      const liveAlias = this.#sqlite.query(`
        SELECT 1 FROM conversation_aliases alias
        INNER JOIN conversations conversation
          ON conversation.tenant_id = alias.tenant_id AND conversation.id = alias.alias_id
        LIMIT 1
      `).get();
      const violations = ["conversation_messages", "conversation_aliases", "message_provider_conversations", "message_thread_edges"]
        .flatMap((table) => this.#sqlite.query(`PRAGMA foreign_key_check('${table}')`).all());
      if (missingMembership || liveAlias || violations.length > 0) {
        throw new Error("Conversation migration failed integrity validation");
      }
      this.#sqlite.query("INSERT INTO schema_migrations (version, applied_at) VALUES (477, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  #recoverConversations(): void {
    const messages = this.#sqlite.query("SELECT * FROM messages ORDER BY tenant_id, identity_key")
      .all() as MessageRow[];
    for (const message of messages) {
      ensureMessageConversation(this.#sqlite, message);
      associateThreadEdges(this.#sqlite, message.tenant_id, message.id,
        [...normalizeMessageIdList(message.in_reply_to), ...parseStoredReferences(message.references)]);
    }
    for (const tenantId of new Set(messages.map(({ tenant_id }) => tenant_id))) {
      repairConversations(this.#sqlite, tenantId, new Set());
    }
  }

  #migrateReferenceSequences(): void {
    if (this.#sqlite.query("SELECT 1 FROM schema_migrations WHERE version = 477002").get()) return;
    const migrate = this.#sqlite.transaction(() => {
      this.#sqlite.exec(`
        CREATE TABLE message_reference_sequences (
          tenant_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          sequence_key TEXT NOT NULL,
          position INTEGER NOT NULL,
          referenced_message_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, message_id, sequence_key, position),
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
        );
      `);
      const violations = this.#sqlite.query("PRAGMA foreign_key_check('message_reference_sequences')").all();
      if (violations.length > 0) throw new Error("Reference sequence migration left invalid foreign keys");
      this.#sqlite.query("INSERT INTO schema_migrations (version, applied_at) VALUES (477002, ?)")
        .run(new Date().toISOString());
    });
    migrate();
  }

  #migrateSemanticMessageIds(): void {
    if (this.#sqlite.query("SELECT 1 FROM schema_migrations WHERE version = 477001").get()) return;
    const migrate = this.#sqlite.transaction(() => {
      const now = new Date().toISOString();
      const edgeRows = this.#sqlite.query(`
        SELECT tenant_id, message_id, referenced_message_id FROM message_thread_edges
      `).all() as Array<{ tenant_id: string; message_id: string; referenced_message_id: string }>;
      const affectedTenants = new Set(edgeRows.map(({ tenant_id }) => tenant_id));
      for (const edge of edgeRows) {
        const normalized = normalizeMessageId(edge.referenced_message_id);
        if (normalized) {
          this.#sqlite.query(`
            INSERT OR IGNORE INTO message_thread_edges (tenant_id, message_id, referenced_message_id)
            VALUES (?, ?, ?)
          `).run(edge.tenant_id, edge.message_id, normalized);
        }
        if (normalized && normalized !== edge.referenced_message_id) {
          this.#sqlite.query(`
            DELETE FROM message_thread_edges
            WHERE tenant_id = ? AND message_id = ? AND referenced_message_id = ?
          `).run(edge.tenant_id, edge.message_id, edge.referenced_message_id);
        }
      }
      const messages = this.#sqlite.query("SELECT * FROM messages ORDER BY tenant_id, created_at, id")
        .all() as MessageRow[];
      const semanticGroups = new Map<string, MessageRow[]>();
      for (const message of messages) {
        affectedTenants.add(message.tenant_id);
        const inReplyToIds = normalizeMessageIdList(message.in_reply_to);
        const references = normalizeMessageIdLists(parseStoredReferences(message.references));
        this.#sqlite.query(`
          UPDATE messages SET in_reply_to = ?, "references" = ? WHERE tenant_id = ? AND id = ?
        `).run(inReplyToIds.length > 0 ? inReplyToIds.join(" ") : null, JSON.stringify(references),
          message.tenant_id, message.id);
        const normalized = normalizeMessageId(message.message_id);
        if (!normalized) continue;
        const key = JSON.stringify([message.tenant_id, normalized]);
        const group = semanticGroups.get(key) ?? [];
        group.push({ ...message, message_id: normalized,
          in_reply_to: inReplyToIds.length > 0 ? inReplyToIds.join(" ") : null,
          references: JSON.stringify(references) });
        semanticGroups.set(key, group);
      }

      for (const group of semanticGroups.values()) {
        const normalizedMessageId = group[0]!.message_id!;
        const identityKey = `message-id:${normalizedMessageId}`;
        const ordered = [...group].sort((left, right) =>
          Number(right.identity_key === identityKey) - Number(left.identity_key === identityKey)
          || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
        const winner = ordered[0]!;
        const losers = ordered.slice(1);
        const metadata = mergeThreadingMetadata(null, [], toThreadingMetadata(this.#sqlite, winner),
          losers.map((row) => toThreadingMetadata(this.#sqlite, row)));
        const receivedAt = earliestReceivedAt(null, winner, losers);
        for (const loser of losers) {
          mergeCanonicalMessages(this.#sqlite, winner.tenant_id, winner.id, loser.id, now);
        }
        this.#sqlite.query(`
          UPDATE messages SET identity_key = ?, message_id = ?, in_reply_to = ?, "references" = ?,
            received_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?
        `).run(identityKey, normalizedMessageId, metadata.inReplyTo, JSON.stringify(metadata.references),
          receivedAt, winner.updated_at, winner.tenant_id, winner.id);
        affectedTenants.add(winner.tenant_id);
      }

      for (const tenantId of affectedTenants) repairConversations(this.#sqlite, tenantId, new Set());
      const staleIdentity = (this.#sqlite.query(`
        SELECT identity_key, message_id FROM messages WHERE message_id IS NOT NULL
      `).all() as Array<{ identity_key: string; message_id: string }>).some(({ identity_key, message_id }) => {
        const normalized = normalizeMessageId(message_id);
        return normalized !== null && (message_id !== normalized || identity_key !== `message-id:${normalized}`);
      });
      const violations = ["messages", "message_locations", "message_aliases", "message_provider_associations",
        "conversation_messages", "conversation_aliases", "message_provider_conversations", "message_thread_edges",
        "message_reference_sequences"]
        .flatMap((table) => this.#sqlite.query(`PRAGMA foreign_key_check('${table}')`).all());
      if (staleIdentity || violations.length > 0) {
        throw new Error("Semantic Message-ID migration failed integrity validation");
      }
      this.#sqlite.query("INSERT INTO schema_migrations (version, applied_at) VALUES (477001, ?)")
        .run(now);
    });
    migrate();
  }
}

interface MessageRow { id: string; tenant_id: string; identity_key: string; message_id: string | null; in_reply_to: string | null; references: string; received_at: string | null; created_at: string; updated_at: string }
interface LocationRow { id: string; message_id: string; tenant_id: string; account_id: string; provider: MailProviderKind; mailbox: string; uid_validity: string; uid: number; modseq: string | null; provider_id: string | null; read: number; flagged: number; observed_at: string }
interface ConversationRow { id: string; tenant_id: string; created_at: string; updated_at: string }
interface DraftRow {
  id: string;
  tenant_id: string;
  account_id: string;
  mode: Draft["mode"];
  recipients_to: string;
  recipients_cc: string;
  recipients_bcc: string;
  subject: string;
  body: string;
  identity: string;
  source: string | null;
  delivery_status: Draft["delivery"]["status"];
  delivery_receipt: string | null;
  delivery_error: string | null;
  claimed_at: string | null;
  claim_owner: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function toDraft(row: DraftRow): Draft {
  const receipt = parseStoredReceipt(row.delivery_receipt);
  if (receipt && receipt.accountId !== row.account_id) {
    throw new Error("Draft delivery receipt belongs to another account");
  }
  const delivery: Draft["delivery"] = (() => {
    switch (row.delivery_status) {
      case "editable":
        return { status: "editable" };
      case "sending":
        if (!row.claimed_at) throw new Error("Sending draft is missing its claim timestamp");
        return { status: "sending", claimedAt: row.claimed_at };
      case "failed":
        if (!row.settled_at || !row.delivery_error) {
          throw new Error("Failed draft is missing its delivery result");
        }
        return {
          status: "failed",
          failedAt: row.settled_at,
          error: row.delivery_error,
          ...(receipt ? { receipt } : {}),
        };
      case "uncertain":
        if (!row.settled_at || !row.delivery_error) {
          throw new Error("Uncertain draft is missing its delivery failure");
        }
        return { status: "uncertain", failedAt: row.settled_at, error: row.delivery_error };
      case "sent":
        if (!row.settled_at || !receipt) throw new Error("Sent draft is missing its delivery result");
        return { status: "sent", settledAt: row.settled_at, receipt };
    }
  })();
  return draftSchema.parse({
    id: row.id,
    accountId: row.account_id,
    mode: row.mode,
    to: parseJson(row.recipients_to),
    cc: parseJson(row.recipients_cc),
    bcc: parseJson(row.recipients_bcc),
    subject: row.subject,
    body: row.body,
    identity: parseJson(row.identity),
    ...(row.source ? { source: parseJson(row.source) } : {}),
    delivery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function parseStoredReceipt(value: string | null): SendReceipt | null {
  return value === null ? null : sendReceiptSchema.parse(parseJson(value));
}

function parseJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return parsed;
}

function toCanonicalMessage(
  row: MessageRow,
  conversationId: string,
  aliases: readonly string[],
): CanonicalMessage {
  return {
    id: row.id,
    aliases: [...aliases],
    tenantId: row.tenant_id,
    conversationId,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: parseStoredReferences(row.references),
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function associateProviderConversation(
  sqlite: Database,
  observation: ProviderMessageObservation,
  messageId: string,
): boolean {
  if (!observation.providerConversationId) return false;
  const location = observation.location;
  const result = sqlite.query(`
    INSERT OR IGNORE INTO message_provider_conversations
      (tenant_id, account_id, provider, provider_conversation_id, message_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(observation.tenantId, location.accountId, location.provider,
    observation.providerConversationId, messageId);
  return result.changes > 0;
}

function associateThreadEdges(
  sqlite: Database,
  tenantId: string,
  messageId: string,
  references: readonly (string | null)[],
): boolean {
  const insert = sqlite.query(`
    INSERT OR IGNORE INTO message_thread_edges (tenant_id, message_id, referenced_message_id)
    VALUES (?, ?, ?)
  `);
  let changed = false;
  for (const reference of new Set(references)) {
    if (reference && insert.run(tenantId, messageId, reference).changes > 0) changed = true;
  }
  return changed;
}

function associateReferenceSequences(
  sqlite: Database,
  tenantId: string,
  messageId: string,
  sequences: readonly (readonly string[])[],
): void {
  const insert = sqlite.query(`
    INSERT OR IGNORE INTO message_reference_sequences
      (tenant_id, message_id, sequence_key, position, referenced_message_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const sequence of sequences) {
    const unique = [...new Set(sequence)];
    if (unique.length === 0) continue;
    const sequenceKey = createHash("sha256").update(JSON.stringify(unique)).digest("hex");
    for (const [position, reference] of unique.entries()) {
      insert.run(tenantId, messageId, sequenceKey, position, reference);
    }
  }
}

function ensureMessageConversation(sqlite: Database, message: MessageRow): void {
  const membership = sqlite.query(`
    SELECT conversation_id FROM conversation_messages WHERE tenant_id = ? AND message_id = ?
  `).get(message.tenant_id, message.id) as { conversation_id: string } | null;
  if (membership) return;
  const alias = sqlite.query(`
    SELECT conversation_id FROM conversation_aliases WHERE tenant_id = ? AND alias_id = ?
  `).get(message.tenant_id, message.id) as { conversation_id: string } | null;
  if (alias) {
    sqlite.query(`
      INSERT INTO conversation_messages (tenant_id, conversation_id, message_id) VALUES (?, ?, ?)
    `).run(message.tenant_id, alias.conversation_id, message.id);
    return;
  }
  sqlite.query(`
    INSERT OR IGNORE INTO conversations (id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?)
  `).run(message.id, message.tenant_id, message.created_at, message.updated_at);
  sqlite.query(`
    INSERT OR IGNORE INTO conversation_messages (tenant_id, conversation_id, message_id) VALUES (?, ?, ?)
  `).run(message.tenant_id, message.id, message.id);
}

function mergeMessageConversationRelations(
  sqlite: Database,
  tenantId: string,
  retainedMessageId: string,
  removedMessageId: string,
): void {
  sqlite.query(`
    INSERT OR IGNORE INTO message_reference_sequences
      (tenant_id, message_id, sequence_key, position, referenced_message_id)
    SELECT tenant_id, ?, sequence_key, position, referenced_message_id FROM message_reference_sequences
    WHERE tenant_id = ? AND message_id = ?
  `).run(retainedMessageId, tenantId, removedMessageId);
  sqlite.query("DELETE FROM message_reference_sequences WHERE tenant_id = ? AND message_id = ?")
    .run(tenantId, removedMessageId);
  sqlite.query(`
    INSERT OR IGNORE INTO message_thread_edges (tenant_id, message_id, referenced_message_id)
    SELECT tenant_id, ?, referenced_message_id FROM message_thread_edges
    WHERE tenant_id = ? AND message_id = ?
  `).run(retainedMessageId, tenantId, removedMessageId);
  sqlite.query("DELETE FROM message_thread_edges WHERE tenant_id = ? AND message_id = ?")
    .run(tenantId, removedMessageId);
  sqlite.query(`
    INSERT OR IGNORE INTO message_provider_conversations
      (tenant_id, account_id, provider, provider_conversation_id, message_id)
    SELECT tenant_id, account_id, provider, provider_conversation_id, ?
    FROM message_provider_conversations
    WHERE tenant_id = ? AND message_id = ?
  `).run(retainedMessageId, tenantId, removedMessageId);
  sqlite.query("DELETE FROM message_provider_conversations WHERE tenant_id = ? AND message_id = ?")
    .run(tenantId, removedMessageId);

  const memberships = sqlite.query(`
    SELECT conversation.*, membership.message_id AS membership_message_id
    FROM conversation_messages membership
    INNER JOIN conversations conversation
      ON conversation.tenant_id = membership.tenant_id AND conversation.id = membership.conversation_id
    WHERE membership.tenant_id = ? AND membership.message_id IN (?, ?)
    ORDER BY CASE WHEN membership.message_id = ? THEN 0 ELSE 1 END,
      conversation.created_at, conversation.id
  `).all(tenantId, retainedMessageId, removedMessageId, retainedMessageId) as Array<ConversationRow & {
    membership_message_id: string;
  }>;
  if (memberships.length === 0) return;
  const winner = memberships[0]!;
  const now = new Date().toISOString();
  for (const mergedId of new Set(memberships.map(({ id }) => id))) {
    if (mergedId === winner.id) continue;
    sqlite.query(`
      UPDATE conversation_messages SET conversation_id = ?
      WHERE tenant_id = ? AND conversation_id = ?
    `).run(winner.id, tenantId, mergedId);
    const remaining = sqlite.query(`
      SELECT 1 FROM conversation_messages WHERE tenant_id = ? AND conversation_id = ? LIMIT 1
    `).get(tenantId, mergedId);
    if (remaining) throw new Error("Cannot alias a conversation that still owns messages");
    sqlite.query(`
      UPDATE conversation_aliases SET conversation_id = ?
      WHERE tenant_id = ? AND conversation_id = ?
    `).run(winner.id, tenantId, mergedId);
    sqlite.query("DELETE FROM conversations WHERE tenant_id = ? AND id = ?")
      .run(tenantId, mergedId);
    sqlite.query(`
      INSERT INTO conversation_aliases (alias_id, tenant_id, conversation_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, alias_id) DO UPDATE SET conversation_id = excluded.conversation_id
    `).run(mergedId, tenantId, winner.id, now);
  }
  sqlite.query("DELETE FROM conversation_messages WHERE tenant_id = ? AND message_id = ?")
    .run(tenantId, removedMessageId);
  sqlite.query(`
    INSERT OR IGNORE INTO conversation_messages (tenant_id, conversation_id, message_id) VALUES (?, ?, ?)
  `).run(tenantId, winner.id, retainedMessageId);
}

function mergeCanonicalMessages(
  sqlite: Database,
  tenantId: string,
  retainedMessageId: string,
  removedMessageId: string,
  now: string,
): void {
  mergeMessageConversationRelations(sqlite, tenantId, retainedMessageId, removedMessageId);
  sqlite.query("UPDATE message_locations SET message_id = ? WHERE tenant_id = ? AND message_id = ?")
    .run(retainedMessageId, tenantId, removedMessageId);
  sqlite.query("UPDATE message_aliases SET message_id = ? WHERE tenant_id = ? AND message_id = ?")
    .run(retainedMessageId, tenantId, removedMessageId);
  sqlite.query("UPDATE message_provider_associations SET message_id = ? WHERE tenant_id = ? AND message_id = ?")
    .run(retainedMessageId, tenantId, removedMessageId);
  sqlite.query(`
    INSERT INTO message_aliases (alias_id, tenant_id, message_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant_id, alias_id) DO UPDATE SET message_id = excluded.message_id
  `).run(removedMessageId, tenantId, retainedMessageId, now);
  sqlite.query("DELETE FROM messages WHERE tenant_id = ? AND id = ?").run(tenantId, removedMessageId);
}

function repairConversations(
  sqlite: Database,
  tenantId: string,
  newConversationIds: ReadonlySet<string>,
  affectedMessageIds?: ReadonlySet<string>,
): void {
  if (affectedMessageIds === undefined) {
    sqlite.query(`
      INSERT OR IGNORE INTO conversations (id, tenant_id, created_at, updated_at)
      SELECT id, tenant_id, created_at, updated_at FROM messages WHERE tenant_id = ?
    `).run(tenantId);
    sqlite.query(`
      INSERT OR IGNORE INTO conversation_messages (tenant_id, conversation_id, message_id)
      SELECT tenant_id, id, id FROM messages WHERE tenant_id = ?
    `).run(tenantId);
  }

  const messageIds = affectedMessageIds === undefined
    ? new Set((sqlite.query("SELECT id FROM messages WHERE tenant_id = ?").all(tenantId) as Array<{ id: string }>)
      .map(({ id }) => id))
    : collectAffectedMessageIds(sqlite, tenantId, affectedMessageIds);
  if (messageIds.size === 0) return;
  const messageIdsJson = affectedMessageIds === undefined ? null : JSON.stringify([...messageIds]);
  const messageFilter = affectedMessageIds === undefined
    ? ""
    : " AND id IN (SELECT value FROM json_each(?))";
  const messages = sqlite.query(`SELECT * FROM messages WHERE tenant_id = ?${messageFilter}`)
    .all(tenantId, ...optionalParameter(messageIdsJson)) as MessageRow[];
  const memberships = sqlite.query(`
    SELECT membership.message_id, membership.conversation_id,
      conversation.created_at AS conversation_created_at
    FROM conversation_messages membership
    INNER JOIN conversations conversation
      ON conversation.tenant_id = membership.tenant_id AND conversation.id = membership.conversation_id
    WHERE membership.tenant_id = ?${affectedMessageIds === undefined
      ? ""
      : " AND membership.message_id IN (SELECT value FROM json_each(?))"}
  `).all(tenantId, ...optionalParameter(messageIdsJson)) as MembershipRow[];
  const membershipByMessage = new Map(memberships.map((membership) => [membership.message_id, membership]));
  if (messages.some(({ id }) => !membershipByMessage.has(id))) {
    throw new Error("Conversation resolver found a message without membership");
  }
  const parent = new Map(messages.map(({ id }) => [id, id]));
  const rank = new Map(messages.map(({ id }) => [id, 0]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      const next = parent.get(root);
      if (!next) throw new Error("Conversation resolver found an unknown message");
      root = next;
    }
    let current = id;
    while (current !== root) {
      const next = parent.get(current);
      if (!next) throw new Error("Conversation resolver found an unknown message");
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = rank.get(leftRoot) ?? 0;
    const rightRank = rank.get(rightRoot) ?? 0;
    if (leftRank < rightRank) parent.set(leftRoot, rightRoot);
    else if (leftRank > rightRank) parent.set(rightRoot, leftRoot);
    else {
      parent.set(rightRoot, leftRoot);
      rank.set(leftRoot, leftRank + 1);
    }
  };

  const existingConversationRoots = new Map<string, string>();
  for (const membership of memberships) {
    const first = existingConversationRoots.get(membership.conversation_id);
    if (first) union(first, membership.message_id);
    else existingConversationRoots.set(membership.conversation_id, membership.message_id);
  }

  const byMessageId = new Map(messages.flatMap((message) =>
    message.message_id ? [[message.message_id, message.id] as const] : []));
  const threadEdges = sqlite.query(`
    SELECT message_id, referenced_message_id FROM message_thread_edges
    WHERE tenant_id = ?${affectedMessageIds === undefined
      ? ""
      : " AND message_id IN (SELECT value FROM json_each(?))"} ORDER BY referenced_message_id, message_id
  `).all(tenantId, ...optionalParameter(messageIdsJson)) as Array<{ message_id: string; referenced_message_id: string }>;
  const unresolvedRoots = new Map<string, string>();
  for (const edge of threadEdges) {
    const linked = byMessageId.get(edge.referenced_message_id);
    if (linked && linked !== edge.message_id) union(edge.message_id, linked);
    const first = unresolvedRoots.get(edge.referenced_message_id);
    if (first) union(first, edge.message_id);
    else unresolvedRoots.set(edge.referenced_message_id, edge.message_id);
  }

  const providerLinks = sqlite.query(`
    SELECT account_id, provider, provider_conversation_id, message_id
    FROM message_provider_conversations${affectedMessageIds === undefined
      ? ""
      : " INDEXED BY message_provider_conversations_message_id_idx"}
    WHERE tenant_id = ?${affectedMessageIds === undefined
      ? ""
      : " AND message_id IN (SELECT value FROM json_each(?))"}
    ORDER BY account_id, provider, provider_conversation_id, message_id
  `).all(tenantId, ...optionalParameter(messageIdsJson)) as Array<{
    account_id: string;
    provider: MailProviderKind;
    provider_conversation_id: string;
    message_id: string;
  }>;
  const providerRoots = new Map<string, string>();
  for (const link of providerLinks) {
    const key = JSON.stringify([link.account_id, link.provider, link.provider_conversation_id]);
    const first = providerRoots.get(key);
    if (first) union(first, link.message_id);
    else providerRoots.set(key, link.message_id);
  }

  const components = new Map<string, string[]>();
  for (const message of messages) {
    const root = find(message.id);
    const members = components.get(root) ?? [];
    members.push(message.id);
    components.set(root, members);
  }
  const now = new Date().toISOString();
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const conversationById = new Map(memberships.map((membership) => [membership.conversation_id, {
    id: membership.conversation_id,
    createdAt: membership.conversation_created_at,
  }]));
  for (const members of components.values()) {
    const candidateIds = [...new Set(members.map((messageId) => membershipByMessage.get(messageId)!.conversation_id))];
    const existing = candidateIds.filter((id) => !newConversationIds.has(id));
    const eligible = existing.length > 0 ? existing : candidateIds;
    const semanticKeyByConversation = new Map<string, string>();
    for (const messageId of members) {
      const conversationId = membershipByMessage.get(messageId)!.conversation_id;
      const identityKey = messageById.get(messageId)!.identity_key;
      const existingKey = semanticKeyByConversation.get(conversationId);
      if (existingKey === undefined || identityKey < existingKey) {
        semanticKeyByConversation.set(conversationId, identityKey);
      }
    }
    const candidates = eligible.map((id) => ({
      ...conversationById.get(id)!,
      semanticKey: semanticKeyByConversation.get(id)!,
    })).sort((left, right) => left.semanticKey.localeCompare(right.semanticKey)
      || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const winner = candidates[0];
    if (!winner) throw new Error("Conversation resolver could not assign a conversation");
    const mergedConversationIds = candidateIds;
    for (const messageId of members) {
      if (membershipByMessage.get(messageId)!.conversation_id === winner.id) continue;
      sqlite.query(`
        UPDATE conversation_messages SET conversation_id = ? WHERE tenant_id = ? AND message_id = ?
      `).run(winner.id, tenantId, messageId);
    }
    if (mergedConversationIds.length > 1) {
      sqlite.query("UPDATE conversations SET updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(now, tenantId, winner.id);
      for (const mergedId of mergedConversationIds) {
        if (mergedId === winner.id) continue;
        const remaining = sqlite.query(`
          SELECT 1 FROM conversation_messages WHERE tenant_id = ? AND conversation_id = ? LIMIT 1
        `).get(tenantId, mergedId);
        if (remaining) throw new Error("Cannot alias a conversation that still owns messages");
        sqlite.query(`
          UPDATE conversation_aliases SET conversation_id = ?
          WHERE tenant_id = ? AND conversation_id = ?
        `).run(winner.id, tenantId, mergedId);
        sqlite.query("DELETE FROM conversations WHERE tenant_id = ? AND id = ?")
          .run(tenantId, mergedId);
        sqlite.query(`
          INSERT INTO conversation_aliases (alias_id, tenant_id, conversation_id, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (tenant_id, alias_id) DO UPDATE SET conversation_id = excluded.conversation_id
        `).run(mergedId, tenantId, winner.id, now);
      }
    }
  }
  if (affectedMessageIds === undefined) {
    sqlite.query(`
      DELETE FROM conversations
      WHERE tenant_id = ? AND NOT EXISTS (
        SELECT 1 FROM conversation_messages membership
        WHERE membership.tenant_id = conversations.tenant_id
          AND membership.conversation_id = conversations.id
      )
    `).run(tenantId);
  }
  const liveAlias = sqlite.query(`
    SELECT 1 FROM conversation_aliases alias
    INNER JOIN conversations conversation
      ON conversation.tenant_id = alias.tenant_id AND conversation.id = alias.alias_id
    WHERE alias.tenant_id = ? LIMIT 1
  `).get(tenantId);
  if (liveAlias) throw new Error("Conversation ID cannot be both live and aliased");
}

interface MembershipRow {
  message_id: string;
  conversation_id: string;
  conversation_created_at: string;
}

function collectAffectedMessageIds(
  sqlite: Database,
  tenantId: string,
  seeds: ReadonlySet<string>,
): Set<string> {
  const affected = new Set(seeds);
  let frontier = [...seeds];
  while (frontier.length > 0) {
    const discovered = new Set<string>();
    const frontierJson = JSON.stringify(frontier);
    const add = (id: string): void => {
      if (!affected.has(id)) discovered.add(id);
    };

    const memberships = sqlite.query(`
      SELECT message_id, conversation_id FROM conversation_messages
      WHERE tenant_id = ? AND message_id IN (SELECT value FROM json_each(?))
    `).all(tenantId, frontierJson) as Array<{ message_id: string; conversation_id: string }>;
    const conversationIds = [...new Set(memberships.map(({ conversation_id }) => conversation_id))];
    if (conversationIds.length > 0) {
      const members = sqlite.query(`
        SELECT message_id FROM conversation_messages INDEXED BY conversation_messages_conversation_id_idx
        WHERE tenant_id = ? AND conversation_id IN (SELECT value FROM json_each(?))
      `).all(tenantId, JSON.stringify(conversationIds)) as Array<{ message_id: string }>;
      for (const member of members) add(member.message_id);
    }

    const messageRows = sqlite.query(`
      SELECT message_id FROM messages
      WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))
    `).all(tenantId, frontierJson) as Array<{ message_id: string | null }>;
    const edges = sqlite.query(`
      SELECT referenced_message_id FROM message_thread_edges
      WHERE tenant_id = ? AND message_id IN (SELECT value FROM json_each(?))
    `).all(tenantId, frontierJson) as Array<{ referenced_message_id: string }>;
    const tokens = [...new Set([
      ...messageRows.flatMap(({ message_id }) => message_id ? [message_id] : []),
      ...edges.map(({ referenced_message_id }) => referenced_message_id),
    ])];
    if (tokens.length > 0) {
      const tokensJson = JSON.stringify(tokens);
      const linkedMessages = sqlite.query(`
        SELECT id FROM messages
        WHERE tenant_id = ? AND message_id IN (SELECT value FROM json_each(?))
      `).all(tenantId, tokensJson) as Array<{ id: string }>;
      const linkedEdges = sqlite.query(`
        SELECT message_id FROM message_thread_edges INDEXED BY message_thread_edges_reference_idx
        WHERE tenant_id = ? AND referenced_message_id IN (SELECT value FROM json_each(?))
      `).all(tenantId, tokensJson) as Array<{ message_id: string }>;
      for (const message of linkedMessages) add(message.id);
      for (const edge of linkedEdges) add(edge.message_id);
    }

    const providerLinks = sqlite.query(`
      SELECT account_id, provider, provider_conversation_id
      FROM message_provider_conversations INDEXED BY message_provider_conversations_message_id_idx
      WHERE tenant_id = ? AND message_id IN (SELECT value FROM json_each(?))
    `).all(tenantId, frontierJson) as Array<{
      account_id: string;
      provider: MailProviderKind;
      provider_conversation_id: string;
    }>;
    const providerKeys = [...new Map(providerLinks.map((link) => [
      JSON.stringify([link.account_id, link.provider, link.provider_conversation_id]), link,
    ])).values()];
    if (providerKeys.length > 0) {
      const peers = sqlite.query(`
        SELECT link.message_id
        FROM json_each(?) provider_key
        CROSS JOIN message_provider_conversations link
        WHERE link.tenant_id = ?
          AND link.account_id = json_extract(provider_key.value, '$.account_id')
          AND link.provider = json_extract(provider_key.value, '$.provider')
          AND link.provider_conversation_id = json_extract(provider_key.value, '$.provider_conversation_id')
      `).all(JSON.stringify(providerKeys), tenantId) as Array<{ message_id: string }>;
      for (const peer of peers) add(peer.message_id);
    }

    frontier = [...discovered];
    for (const id of frontier) affected.add(id);
  }
  return affected;
}

function optionalParameter(value: string | null): [] | [string] {
  return value === null ? [] : [value];
}

function parseStoredReferences(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) {
    throw new Error("Stored message references are invalid");
  }
  return parsed;
}

function toThreadingMetadata(sqlite: Database, message: MessageRow): ThreadingMetadata {
  const rows = sqlite.query(`
    SELECT sequence_key, position, referenced_message_id FROM message_reference_sequences
    WHERE tenant_id = ? AND message_id = ? ORDER BY sequence_key, position
  `).all(message.tenant_id, message.id) as Array<{
    sequence_key: string;
    position: number;
    referenced_message_id: string;
  }>;
  const sequences = new Map<string, string[]>();
  for (const row of rows) {
    const sequence = sequences.get(row.sequence_key) ?? [];
    sequence[row.position] = row.referenced_message_id;
    sequences.set(row.sequence_key, sequence);
  }
  return {
    inReplyTo: message.in_reply_to,
    references: parseStoredReferences(message.references),
    referenceSequences: [...sequences.values()],
  };
}

function earliestReceivedAt(
  observed: string | null,
  canonical: MessageRow,
  merged: readonly MessageRow[],
): string | null {
  return [observed, canonical.received_at, ...merged.map(({ received_at }) => received_at)]
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;
}

function toConversationMessageForOrder(
  message: MessageRow,
  threadingEdges: readonly string[] = [],
  referenceSequences: readonly (readonly string[])[] = [],
) {
  return {
    id: message.id,
    identityKey: message.identity_key,
    messageId: message.message_id,
    inReplyTo: message.in_reply_to,
    references: parseStoredReferences(message.references),
    receivedAt: message.received_at,
    threadingEdges,
    referenceSequences,
  };
}

function normalizedReferenceSequences(
  observation: ProviderMessageObservation,
  references: readonly string[],
): string[][] {
  return (observation.referenceSequences ?? [references])
    .map((sequence) => normalizeMessageIdLists(sequence))
    .filter((sequence) => sequence.length > 0);
}

function fallbackIdentityKeyFor(observation: CanonicalMessageObservation): string {
  const location = observation.location;
  return `provider:${JSON.stringify(location.providerId
    ? [location.provider, location.accountId, location.providerId]
    : [location.provider, location.accountId, location.mailbox, location.uidValidity, location.uid])}`;
}

function legacyFallbackIdentityKeyFor(
  sqlite: Database,
  observation: CanonicalMessageObservation,
): string | null {
  const location = observation.location;
  if (!location.providerId && (location.mailbox.includes(":") || location.uidValidity.includes(":"))) return null;
  const key = `provider:${location.provider}:${location.accountId}:${legacyLocationKeyFor(observation)}`;
  const accounts = sqlite.query("SELECT id FROM accounts WHERE kind = ?").all(location.provider) as Array<{ id: string }>;
  const candidates = accounts.filter(({ id }) => couldBeLegacyFallbackForAccount(key, location.provider, id));
  return candidates.length === 1 && candidates[0]!.id === location.accountId ? key : null;
}

function couldBeLegacyFallbackForAccount(key: string, provider: MailProviderKind, accountId: string): boolean {
  const providerPrefix = `provider:${provider}:${accountId}:provider-id:`;
  if (key.startsWith(providerPrefix)) return key.length > providerPrefix.length;
  const imapPrefix = `provider:${provider}:${accountId}:imap:`;
  if (!key.startsWith(imapPrefix)) return false;
  const parts = key.slice(imapPrefix.length).split(":");
  return parts.length >= 3 && parts.every((part) => part.length > 0) && /^[1-9]\d*$/.test(parts.at(-1)!);
}

function locationKeyFor(observation: CanonicalMessageObservation): string {
  const location = observation.location;
  return JSON.stringify(location.providerId
    ? ["provider-id", location.providerId]
    : ["imap", location.mailbox, location.uidValidity, location.uid]);
}

function legacyLocationKeyFor(observation: CanonicalMessageObservation): string {
  const location = observation.location;
  return location.providerId
    ? `provider-id:${location.providerId}`
    : `imap:${location.mailbox}:${location.uidValidity}:${location.uid}`;
}

function findProviderCanonical(sqlite: Database, observation: CanonicalMessageObservation): MessageRow | null {
  const location = observation.location;
  const identity = location.providerId
    ? "association.provider_id = ?"
    : "association.provider_id IS NULL AND association.mailbox = ? AND association.uid_validity = ? AND association.uid = ?";
  const values = location.providerId ? [location.providerId] : [location.mailbox, location.uidValidity, location.uid];
  return sqlite.query(`
    SELECT message.*
    FROM message_provider_associations association
    INNER JOIN messages message
      ON message.tenant_id = association.tenant_id AND message.id = association.message_id
    WHERE association.tenant_id = ? AND association.account_id = ? AND association.provider = ? AND ${identity}
    LIMIT 1
  `).get(observation.tenantId, location.accountId, location.provider, ...values) as MessageRow | null;
}

function findCanonicalForReference(
  sqlite: Database,
  tenantId: string,
  provider: MailProviderKind,
  reference: MessageRef,
): MessageRow | null {
  const association = reference.providerId
    ? sqlite.query(`
        SELECT message.* FROM message_provider_associations association
        INNER JOIN messages message
          ON message.tenant_id = association.tenant_id AND message.id = association.message_id
        WHERE association.tenant_id = ? AND association.account_id = ? AND association.provider = ?
          AND association.provider_id = ?
        LIMIT 1
      `).get(tenantId, reference.accountId, provider, reference.providerId) as MessageRow | null
    : sqlite.query(`
        SELECT message.* FROM message_provider_associations association
        INNER JOIN messages message
          ON message.tenant_id = association.tenant_id AND message.id = association.message_id
        WHERE association.tenant_id = ? AND association.account_id = ? AND association.provider = ?
          AND association.provider_id IS NULL AND association.mailbox = ?
          AND association.uid_validity = ? AND association.uid = ?
        LIMIT 1
      `).get(tenantId, reference.accountId, provider, reference.mailbox,
        reference.uidValidity, reference.uid) as MessageRow | null;
  if (association) return association;
  return sqlite.query(`
    SELECT message.* FROM message_locations location
    INNER JOIN messages message
      ON message.tenant_id = location.tenant_id AND message.id = location.message_id
    WHERE location.tenant_id = ? AND location.account_id = ? AND location.provider = ?
      AND location.mailbox = ? AND location.uid_validity = ? AND location.uid = ?
      AND ((? IS NULL AND location.provider_id IS NULL) OR location.provider_id = ?)
    LIMIT 1
  `).get(tenantId, reference.accountId, provider, reference.mailbox, reference.uidValidity,
    reference.uid, reference.providerId ?? null, reference.providerId ?? null) as MessageRow | null;
}

function associateProviderReference(
  sqlite: Database,
  tenantId: string,
  provider: MailProviderKind,
  reference: MessageRef,
  messageId: string,
): void {
  sqlite.query(`
    INSERT INTO message_provider_associations
      (tenant_id, account_id, provider, provider_id, mailbox, uid_validity, uid, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET message_id = excluded.message_id
  `).run(tenantId, reference.accountId, provider, reference.providerId ?? null,
    reference.providerId ? null : reference.mailbox,
    reference.providerId ? null : reference.uidValidity,
    reference.providerId ? null : reference.uid,
    messageId);
}

function associateProviderObservation(
  sqlite: Database,
  observation: CanonicalMessageObservation,
  messageId: string,
): void {
  const location = observation.location;
  associateProviderReference(sqlite, observation.tenantId, location.provider, {
    accountId: location.accountId,
    mailbox: location.mailbox,
    uidValidity: location.uidValidity,
    uid: location.uid,
    modseq: location.modseq,
    ...(location.providerId ? { providerId: location.providerId } : {}),
  }, messageId);
}

function toStoredLocation(row: LocationRow): StoredMessageLocation {
  return { id: row.id, messageId: row.message_id, tenantId: row.tenant_id, accountId: row.account_id,
    provider: row.provider, mailbox: row.mailbox, uidValidity: row.uid_validity, uid: row.uid, modseq: row.modseq,
    providerId: row.provider_id, read: row.read === 1, flagged: row.flagged === 1, observedAt: row.observed_at };
}
