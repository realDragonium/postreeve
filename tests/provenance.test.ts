import { describe, expect, test } from "bun:test";
import type { OperationBatch, Proposal, MessageRef } from "../src/shared/contracts";
import { buildProvenance, provenanceKey, recordUserBatch } from "../src/web/provenance";

const ref: MessageRef = { accountId: "a", mailbox: "INBOX", uidValidity: "1", uid: 7, modseq: null };
const key = provenanceKey(ref);

function batch(overrides: Partial<OperationBatch> & { id: string }): OperationBatch {
  return {
    proposalId: "p1",
    accountId: "a",
    status: "applied",
    operations: [{ itemId: "i1", message: ref, action: { type: "mark_read" }, status: "applied", error: null }],
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

function proposal(overrides: Partial<Proposal> & { id: string }): Proposal {
  return {
    accountId: "a",
    title: "Triage",
    status: "review",
    items: [{ id: "pi1", message: ref, subject: "Invoice", action: { type: "move", destination: "Finance" }, reason: "" }],
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    approvedAt: null,
    batchId: null,
    ...overrides,
  };
}

describe("buildProvenance", () => {
  test("describes what the newest applied batch did to a message", () => {
    expect(buildProvenance([batch({ id: "b1" })], []).get(key))
      .toMatchObject({ kind: "applied", lead: "marked read", batchId: "b1" });
  });

  test("the newest batch wins when a message was touched twice", () => {
    const entry = buildProvenance([
      batch({ id: "old", updatedAt: "2026-08-01T09:00:00.000Z" }),
      batch({
        id: "new",
        updatedAt: "2026-08-02T09:00:00.000Z",
        operations: [{ itemId: "i2", message: ref, action: { type: "move", destination: "Keep" }, status: "applied", error: null }],
      }),
    ], []).get(key);
    expect(entry).toMatchObject({ batchId: "new", lead: "moved to Keep" });
  });

  test("an undone batch leaves no trace on the message", () => {
    expect(buildProvenance([batch({ id: "b1", status: "undone" })], []).has(key)).toBe(false);
  });

  test("a failed operation inside an applied batch is not claimed as done", () => {
    const failed = batch({ id: "b1" });
    expect(buildProvenance([{
      ...failed,
      operations: [{ ...failed.operations[0]!, status: "failed", error: "no such mailbox" }],
    }], []).has(key)).toBe(false);
  });

  test("an open proposal outranks history, because it is what awaits a decision", () => {
    const entry = buildProvenance([batch({ id: "b1" })], [proposal({ id: "p1" })]).get(key);
    expect(entry).toMatchObject({ kind: "proposed", mark: "◇", lead: "proposes move to Finance", proposalId: "p1" });
  });

  test("a settled proposal is history, not a pending decision", () => {
    expect(buildProvenance([], [proposal({ id: "p1", status: "applied" })]).has(key)).toBe(false);
  });

  test("an operation this session sent is attributed to you, an unknown one is not guessed", () => {
    expect(buildProvenance([batch({ id: "unknown" })], []).get(key)?.lead).toBe("marked read");
    recordUserBatch("mine");
    expect(buildProvenance([batch({ id: "mine" })], []).get(key)?.lead).toBe("you marked read");
  });
});
