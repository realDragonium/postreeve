import type { ESearchResult } from "imapflow";

// Use the same membership proof before and after ImapFlow normalizes responses.
export function imapSearchUids(
  result: ESearchResult | number[],
  { limit, minimum = 1, maximum = 0xffff_ffff, requireCount = true }:
    { limit: number; minimum?: number; maximum?: number; requireCount?: boolean },
): number[] {
  if (!Array.isArray(result) && (result.partial !== undefined
    || (requireCount && result.count === undefined)
    || (result.count !== undefined && (!Number.isSafeInteger(result.count) || result.count < 0)))) {
    throw new Error("IMAP SEARCH omitted complete UID coverage");
  }
  const parts = Array.isArray(result) ? result.map(String) : (result.all ? result.all.split(",") : []);
  const ranges = parts.map(part => {
    const match = /^(\d+)(?::(\d+))?$/.exec(part);
    if (!match) throw new Error("IMAP returned invalid UID search coverage");
    const first = Number(match[1]);
    const second = Number(match[2] ?? match[1]);
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low < minimum || high > maximum) {
      throw new Error("IMAP UID search crossed the requested range");
    }
    return { low, high };
  }).sort((a, b) => a.low - b.low);
  const merged: Array<{ low: number; high: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.low <= previous.high + 1) previous.high = Math.max(previous.high, range.high);
    else merged.push({ ...range });
  }
  const count = merged.reduce((total, range) => total + range.high - range.low + 1, 0);
  if (!Array.isArray(result) && ((result.count !== undefined && result.count !== count)
    || (result.min !== undefined && result.min !== merged[0]?.low)
    || (result.max !== undefined && result.max !== merged.at(-1)?.high))) {
    throw new Error("IMAP SEARCH count disagrees with UID coverage");
  }
  const selected: number[] = [];
  for (const range of merged) {
    for (let uid = range.low; uid <= range.high && selected.length < limit; uid++) selected.push(uid);
    if (selected.length === limit) break;
  }
  return selected;
}
