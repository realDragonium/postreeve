import type { CanonicalMessageSummary } from "./contracts";

export function uniqueCanonicalMessages(
  messages: readonly CanonicalMessageSummary[],
): CanonicalMessageSummary[] {
  const unique: CanonicalMessageSummary[] = [];
  const indexes = new Map<string, number>();

  for (const message of messages) {
    const existingIndex = indexes.get(message.canonicalId);
    if (existingIndex === undefined) {
      indexes.set(message.canonicalId, unique.length);
      unique.push(message);
      continue;
    }

    const representative = unique[existingIndex]!;
    const aliases = [...new Set([
      ...representative.canonicalAliases,
      ...message.canonicalAliases,
    ])].filter((alias) => alias !== representative.canonicalId);
    unique[existingIndex] = { ...representative, canonicalAliases: aliases };
  }

  return unique;
}
