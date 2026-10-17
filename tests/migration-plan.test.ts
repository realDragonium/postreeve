import { describe, expect, test } from "bun:test";
import { createMailServerProposalInputSchema } from "../src/shared/mail-server";
import { imapsyncScript, inventoryFromPoste, planFromInventory } from "../scripts/migration/plan";

const posteDomains = [{ name: "example.org" }, { name: "example.net" }];
const posteBoxes = [
  { address: "Alice@example.org", name: "Alice", storage_limit: 1024, redirect_to: [], redirect_only: false },
  { address: "bob@example.org", name: "Bob", storage_limit: 0, redirect_to: ["bob@gmail.example.com"], redirect_only: false, disabled: true },
  { address: "info@example.org", name: "Info", redirect_to: ["alice@example.org"], redirect_only: true },
  { address: "team@example.net", name: "Team", redirect_to: ["alice@example.org", "bob@example.org"], redirect_only: true },
  { address: "*@example.net", name: "", redirect_to: ["alice@example.org"], redirect_only: true },
  { address: "carol@elsewhere.example.com", name: "Carol", redirect_only: false },
];

describe("poste.io migration plan", () => {
  test("maps boxes, forwards and catch-all to a valid Postreeve proposal", () => {
    const inventory = inventoryFromPoste(posteDomains, posteBoxes);
    expect(inventory.mailboxes[0]).toEqual({ address: "Alice@example.org", name: "Alice", quotaBytes: 1073741824, redirectTo: [], redirectOnly: false, disabled: false });
    const plan = planFromInventory(inventory, { addToPostreeve: ["alice@example.org"] });
    expect(plan.operations).toEqual([
      { type: "addDomain", domain: "example.net" },
      { type: "addDomain", domain: "example.org" },
      { type: "createMailbox", address: "alice@example.org", displayName: "Alice", quotaBytes: 1073741824, addToPostreeve: true },
      { type: "createMailbox", address: "bob@example.org", displayName: "Bob", quotaBytes: null, addToPostreeve: false },
      { type: "addAlias", address: "alice@example.org", alias: "info@example.org" },
      { type: "createMailingList", address: "team@example.net", description: "Team", recipients: ["alice@example.org", "bob@example.org"] },
      { type: "setCatchAll", domain: "example.net", address: "alice@example.org" },
    ]);
    expect(plan.copyMail).toEqual(["alice@example.org", "bob@example.org"]);
    expect(plan.manual).toEqual([
      "bob@example.org is disabled on poste.io; it is created enabled, so decide whether you still need it",
      "bob@example.org keeps mail and also forwards to bob@gmail.example.com; recreate that with a Sieve redirect rule in Stalwart",
      "carol@elsewhere.example.com: its domain is not in the domain list; skipped",
    ]);
    expect(createMailServerProposalInputSchema.safeParse({ title: plan.title, operations: plan.operations }).success).toBe(true);
  });

  test("the imapsync script reads passwords from files and dry-runs by default", () => {
    const script = imapsyncScript(["alice@example.org"], { oldHost: "old.example.org", newHost: "mail.example.org", passwordDir: "./pw", dryRun: true });
    expect(script).toContain("--passfile1 './pw/alice@example.org.old'");
    expect(script).toContain("--passfile2 './pw/alice@example.org.new'");
    expect(script).toContain("--dry");
    expect(script).not.toMatch(/--password[12]/);
    expect(imapsyncScript(["a@example.org"], { oldHost: "o", newHost: "n", passwordDir: "p", dryRun: false })).not.toContain("--dry");
  });
});
