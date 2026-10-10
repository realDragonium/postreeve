import {
  createIdentityInputSchema,
  type Account,
  type CreateIdentityInput,
  type Identity,
  type MessageSummary,
} from "../shared/contracts";
import { ApiRequestError } from "./api";
import type { DraftMigrationStorage } from "./draft-state";

export const localIdentitiesKey = "postreeve.local-identities.v1";
export const localIdentityMigrationKey = "postreeve.local-identities.migrated.v1";

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

export interface IdentityMigrationResult {
  readonly migrated: number;
  readonly retryable: number;
}

export async function migrateLocalIdentitiesOnce(
  storage: DraftMigrationStorage,
  accounts: readonly Account[],
  add: (accountId: string, input: CreateIdentityInput) => Promise<Identity>,
): Promise<IdentityMigrationResult> {
  if (storage.getItem(localIdentityMigrationKey) === "complete") return { migrated: 0, retryable: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(localIdentitiesKey) ?? "[]");
  } catch {
    parsed = [];
  }
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const remaining: unknown[] = [];
  let migrated = 0;
  for (const candidate of Array.isArray(parsed) ? parsed : []) {
    if (!isLocalIdentity(candidate)) continue;
    const account = accountsById.get(candidate.accountId);
    if (!account) {
      remaining.push(candidate);
      continue;
    }
    const input = createIdentityInputSchema.safeParse({ name: candidate.name, address: candidate.email });
    if (!input.success || input.data.address === account.email.toLowerCase()) continue;
    try {
      await add(account.id, input.data);
      migrated += 1;
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 400)) remaining.push(candidate);
    }
  }
  storage.setItem(localIdentitiesKey, JSON.stringify(remaining));
  if (remaining.length === 0) storage.setItem(localIdentityMigrationKey, "complete");
  return { migrated, retryable: remaining.length };
}

interface LocalIdentity {
  readonly accountId: string;
  readonly name: string;
  readonly email: string;
}

function isLocalIdentity(value: unknown): value is LocalIdentity {
  return typeof value === "object" && value !== null
    && "accountId" in value && typeof value.accountId === "string"
    && "name" in value && typeof value.name === "string"
    && "email" in value && typeof value.email === "string";
}
