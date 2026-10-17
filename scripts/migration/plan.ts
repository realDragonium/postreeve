import type { MailServerOperationInput } from "../../src/shared/mail-server";

/** What exists on the old server, from poste.io's admin API or written by hand. */
export interface Inventory {
  readonly domains: readonly string[];
  readonly mailboxes: readonly InventoryBox[];
}

export interface InventoryBox {
  readonly address: string;
  readonly name: string;
  readonly quotaBytes: number | null;
  /** Addresses poste.io forwards this box to. */
  readonly redirectTo: readonly string[];
  /** True when the box only forwards and stores nothing. */
  readonly redirectOnly: boolean;
  readonly disabled: boolean;
}

export interface MigrationPlan {
  readonly title: string;
  readonly operations: MailServerOperationInput[];
  /** Things the plan cannot express; the owner handles them by hand. */
  readonly manual: string[];
  /** Mailboxes whose mail must be copied. */
  readonly copyMail: string[];
}

const lower = (value: string) => value.trim().toLowerCase();

/** Turns an inventory into a Postreeve mail server proposal. Pure, so it is safe to run and test anywhere. */
export function planFromInventory(inventory: Inventory, options: { addToPostreeve?: readonly string[] } = {}): MigrationPlan {
  const addToPostreeve = new Set((options.addToPostreeve ?? []).map(lower));
  const domains = [...new Set(inventory.domains.map(lower))].sort();
  const boxes = inventory.mailboxes.map((box) => ({ ...box, address: lower(box.address), redirectTo: box.redirectTo.map(lower) }));
  const stored = boxes.filter((box) => !box.redirectOnly && !isWildcard(box.address));
  const storedAddresses = new Set(stored.map(({ address }) => address));
  const operations: MailServerOperationInput[] = domains.map((domain) => ({ type: "addDomain", domain }));
  const manual: string[] = [];

  for (const box of stored) {
    if (!domains.includes(domainOf(box.address))) {
      manual.push(`${box.address}: its domain is not in the domain list; skipped`);
      continue;
    }
    operations.push({
      type: "createMailbox", address: box.address, displayName: box.name, quotaBytes: box.quotaBytes,
      addToPostreeve: addToPostreeve.has(box.address),
    });
    if (box.disabled) manual.push(`${box.address} is disabled on poste.io; it is created enabled, so decide whether you still need it`);
    if (box.redirectTo.length) manual.push(`${box.address} keeps mail and also forwards to ${box.redirectTo.join(", ")}; recreate that with a Sieve redirect rule in Stalwart`);
  }

  for (const box of boxes.filter((candidate) => candidate.redirectOnly || isWildcard(candidate.address))) {
    if (box.redirectTo.length === 0) {
      manual.push(`${box.address} forwards nowhere; skipped`);
      continue;
    }
    if (isWildcard(box.address)) {
      const [target] = box.redirectTo;
      if (box.redirectTo.length === 1 && storedAddresses.has(target!)) {
        operations.push({ type: "setCatchAll", domain: domainOf(box.address), address: target! });
      } else {
        manual.push(`catch-all ${box.address} goes to ${box.redirectTo.join(", ")}; Stalwart's catch-all takes one local address`);
      }
      continue;
    }
    const [target] = box.redirectTo;
    if (box.redirectTo.length === 1 && storedAddresses.has(target!)) {
      operations.push({ type: "addAlias", address: target!, alias: box.address });
    } else {
      operations.push({ type: "createMailingList", address: box.address, description: box.name, recipients: [...box.redirectTo] });
    }
  }

  return {
    title: `Migrate ${domains.length} domain${domains.length === 1 ? "" : "s"} from poste.io`,
    operations,
    manual,
    copyMail: stored.filter(({ address }) => domains.includes(domainOf(address))).map(({ address }) => address),
  };
}

function isWildcard(address: string): boolean {
  return address.startsWith("*@") || address.startsWith("@");
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * Reads poste.io admin API records into an inventory. Field names follow poste.io's v1 API as commonly
 * returned (`address`, `name`, `redirect_to`, `redirect_only`, `storage_limit`, `disabled`); check them against
 * `https://<poste-host>/admin/api/doc` on your server, and pass `quotaUnit` to match `storage_limit`.
 */
export function inventoryFromPoste(domains: readonly unknown[], boxes: readonly unknown[], quotaUnit: "mb" | "bytes" = "mb"): Inventory {
  const record = (value: unknown) => (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    domains: domains.map((domain) => typeof domain === "string" ? domain : String(record(domain).name ?? record(domain).domain ?? "")).filter(Boolean),
    mailboxes: boxes.map((raw) => {
      const box = record(raw);
      const limit = Number(box.storage_limit ?? box.quota ?? 0);
      const redirect = box.redirect_to ?? box.redirects ?? [];
      return {
        address: String(box.address ?? box.email ?? ""),
        name: String(box.name ?? ""),
        quotaBytes: limit > 0 ? (quotaUnit === "mb" ? limit * 1024 * 1024 : limit) : null,
        redirectTo: (Array.isArray(redirect) ? redirect : String(redirect).split(/[\s,]+/)).map(String).filter(Boolean),
        redirectOnly: box.redirect_only === true || box.redirectOnly === true,
        disabled: box.disabled === true,
      };
    }).filter(({ address }) => address.includes("@")),
  };
}

/** Builds an imapsync script. Passwords come from files named per mailbox, never from the command line. */
export function imapsyncScript(addresses: readonly string[], options: { oldHost: string; newHost: string; oldPort?: number; newPort?: number; newSelfSigned?: boolean; oldSelfSigned?: boolean; passwordDir: string; dryRun: boolean }): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return [
    "#!/bin/sh",
    "# Generated by scripts/migration/imapsync-plan.ts. Copies mail; it never deletes on either side.",
    "# Each mailbox needs <passwordDir>/<address>.old and <address>.new files (chmod 600) holding its passwords.",
    "set -eu",
    ...addresses.map((address) => [
      "imapsync",
      `--host1 ${quote(options.oldHost)} --port1 ${options.oldPort ?? 993} --ssl1 --user1 ${quote(address)} --passfile1 ${quote(`${options.passwordDir}/${address}.old`)}`,
      `--host2 ${quote(options.newHost)} --port2 ${options.newPort ?? 993} --ssl2 --user2 ${quote(address)} --passfile2 ${quote(`${options.passwordDir}/${address}.new`)}`,
      // Only for loopback hops, where the certificate cannot match "localhost".
      options.oldSelfSigned ? "--sslargs1 SSL_verify_mode=0" : "",
      options.newSelfSigned ? "--sslargs2 SSL_verify_mode=0" : "",
      "--automap --syncinternaldates --nofoldersizes",
      options.dryRun ? "--dry" : "",
      `--logfile ${quote(`imapsync-${address}.log`)}`,
    ].filter(Boolean).join(" ")),
    "",
  ].join("\n");
}
