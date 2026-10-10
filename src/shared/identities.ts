import type { Account, Identity, MessageSummary } from "./contracts";

export function ownAddresses(account: Account, identities: readonly Identity[]): ReadonlySet<string> {
  return new Set([account.email, ...identities.map(({ address }) => address)].map((address) => address.toLowerCase()));
}

/** The first own address the source was delivered to, so a reply leaves from the alias that received it. */
export function defaultFromAddress(
  source: Pick<MessageSummary, "deliveredTo" | "to" | "cc">,
  account: Account,
  identities: readonly Identity[],
): string {
  const own = ownAddresses(account, identities);
  const candidates = [...source.deliveredTo ?? [], ...source.to.map(({ address }) => address), ...(source.cc ?? []).map(({ address }) => address)];
  const match = candidates.find((address) => own.has(address.toLowerCase()))?.toLowerCase();
  return identities.find(({ address }) => address === match)?.address ?? account.email;
}
