import { describe, expect, test } from "bun:test";
import type { Account, CreateIdentityInput, Identity } from "../src/shared/contracts";
import { ApiRequestError } from "../src/web/api";
import {
  defaultFromAddress,
  localIdentitiesKey,
  localIdentityMigrationKey,
  migrateLocalIdentitiesOnce,
} from "../src/web/identities";

const account: Account = { id: "account-a", name: "Owner", email: "Owner@example.test", kind: "imap" };
const sales: Identity = {
  id: "sales", accountId: account.id, name: "Sales", address: "sales@example.test", createdAt: "2026-10-10T00:00:00.000Z",
};
const support: Identity = { ...sales, id: "support", name: "Support", address: "support@example.test" };

describe("reply From default", () => {
  const person = (address: string) => ({ name: "", address });

  test("prefers the delivered-to identity over To and Cc", () => {
    expect(defaultFromAddress({
      deliveredTo: ["SALES@example.test"],
      to: [person("support@example.test")],
      cc: [],
    }, account, [sales, support])).toBe("sales@example.test");
  });

  test("falls back to To, then Cc, then the primary address", () => {
    expect(defaultFromAddress({ to: [person("someone@example.test")], cc: [person("support@example.test")] }, account, [sales, support]))
      .toBe("support@example.test");
    expect(defaultFromAddress({ to: [person("owner@example.test"), person("sales@example.test")] }, account, [sales]))
      .toBe(account.email);
    expect(defaultFromAddress({ deliveredTo: ["catchall@example.test"], to: [person("someone@example.test")] }, account, [sales]))
      .toBe(account.email);
  });
});

describe("browser-local identity migration", () => {
  test("adds valid identities, drops invalid ones and retries the rest until complete", async () => {
    const local = (id: string, accountId: string, email: string) => ({ id, accountId, name: id, email });
    const storage = memoryStorage({ [localIdentitiesKey]: JSON.stringify([
      local("sales", account.id, "sales@example.test"),
      local("primary", account.id, "owner@example.test"),
      local("refused", account.id, "refused@example.test"),
      local("flaky", account.id, "flaky@example.test"),
      local("later", "account-later", "later@example.test"),
      { malformed: true },
    ]) });
    const added: string[] = [];
    let flaky = true;
    const add = async (_accountId: string, input: CreateIdentityInput): Promise<Identity> => {
      if (input.address === "refused@example.test") throw new ApiRequestError("Invalid", 400, null);
      if (input.address === "flaky@example.test" && flaky) throw new ApiRequestError("Unavailable", 500, null);
      added.push(input.address);
      return { ...sales, address: input.address };
    };

    expect(await migrateLocalIdentitiesOnce(storage, [account], add)).toEqual({ migrated: 1, retryable: 2 });
    expect(storage.getItem(localIdentityMigrationKey)).toBeNull();

    flaky = false;
    const later: Account = { id: "account-later", name: "Later", email: "later-owner@example.test", kind: "gmail" };
    expect(await migrateLocalIdentitiesOnce(storage, [account, later], add)).toEqual({ migrated: 2, retryable: 0 });
    expect(storage.getItem(localIdentityMigrationKey)).toBe("complete");
    expect(await migrateLocalIdentitiesOnce(storage, [account, later], add)).toEqual({ migrated: 0, retryable: 0 });
    expect(added).toEqual(["sales@example.test", "flaky@example.test", "later@example.test"]);
  });
});

function memoryStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
