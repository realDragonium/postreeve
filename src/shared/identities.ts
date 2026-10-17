import type { Account, Identity, MessageSummary, OutboundAddress, Signature } from "./contracts";

export function isWildcardAddress(address: string): boolean {
  return address.startsWith("*@");
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * The sender an address resolves to for this account: the primary address, an exact identity, or a wildcard
 * identity `*@domain` on exactly the address's domain. `null` means the account may not send as the address.
 */
export function identityFor(address: string, account: Account, identities: readonly Identity[]): OutboundAddress | null {
  const normalized = address.trim().toLowerCase();
  if (!normalized || isWildcardAddress(normalized)) return null;
  if (normalized === account.email.toLowerCase()) return { name: account.name, address: account.email };
  const exact = identities.find((identity) => identity.address === normalized);
  if (exact) return { name: exact.name, address: exact.address };
  const wildcard = identities.find((identity) => identity.address === `*@${domainOf(normalized)}`);
  return wildcard ? { name: wildcard.name, address: normalized } : null;
}

export function isOwnAddress(address: string, account: Account, identities: readonly Identity[]): boolean {
  return identityFor(address, account, identities) !== null;
}

/** The first own address the source was delivered to, so a reply leaves from the alias that received it. */
export function defaultFromAddress(
  source: Pick<MessageSummary, "deliveredTo" | "to" | "cc">,
  account: Account,
  identities: readonly Identity[],
): string {
  const candidates = [...source.deliveredTo ?? [], ...source.to.map(({ address }) => address), ...(source.cc ?? []).map(({ address }) => address)];
  for (const candidate of candidates) {
    const identity = identityFor(candidate, account, identities);
    if (identity) return identity.address;
  }
  return account.email;
}

/** The signature for a sending address: its own, or else the one of the wildcard identity covering it. */
export function signatureHtmlFor(address: string, signatures: readonly Signature[]): string {
  const normalized = address.toLowerCase();
  return signatures.find((signature) => signature.address === normalized)?.html
    ?? signatures.find((signature) => signature.address === `*@${domainOf(normalized)}`)?.html
    ?? "";
}
