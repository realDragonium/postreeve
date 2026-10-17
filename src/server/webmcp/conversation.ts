import type { CanonicalMessageDetail, CanonicalMessageSummary, MessageRef } from "../../shared/contracts.ts";

/**
 * A conversation can span accounts, but one read request covers one account,
 * so reads are grouped per account and stitched back into conversation order.
 */
export async function readConversationDetails(
  summaries: readonly CanonicalMessageSummary[],
  read: (references: MessageRef[]) => Promise<readonly CanonicalMessageDetail[]>,
  limit: number,
): Promise<CanonicalMessageDetail[]> {
  const ordered = [...summaries]
    .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
    .slice(-limit);
  const byAccount = new Map<string, CanonicalMessageSummary[]>();
  for (const summary of ordered) {
    byAccount.set(summary.ref.accountId, [...byAccount.get(summary.ref.accountId) ?? [], summary]);
  }
  const details = new Map<string, CanonicalMessageDetail>();
  for (const group of byAccount.values()) {
    const read_ = await read(group.map(({ ref }) => ref));
    read_.forEach((detail, index) => details.set(group[index]!.canonicalId, detail));
  }
  return ordered.flatMap(({ canonicalId }) => details.get(canonicalId) ?? []);
}
