import { createHash } from "node:crypto";
import type { DnsChange } from "../../shared/dns-providers";
import { absolute, normalizeValue, recordKey, type DnsValue, type ProviderRecord } from "./types";

export interface PlannedChange extends DnsChange {
  /** The provider record an update or delete touches. */
  readonly record: ProviderRecord | null;
  /** The value a create or update writes. */
  readonly next: DnsValue | null;
}

export interface Plan {
  readonly changes: PlannedChange[];
  readonly inSync: number;
  readonly fingerprint: string;
}

const txtKinds = ["v=spf1", "v=dmarc1", "v=dkim1", "v=stsv1", "v=tlsrptv1", "v=uaac1"];

/** The kind of a TXT policy record, so a required SPF replaces an SPF and never a site verification. */
export function txtKind(value: string): string | null {
  const lower = value.trim().toLowerCase();
  return txtKinds.find((kind) => lower.startsWith(kind)) ?? null;
}

const sameValue = (a: DnsValue, b: DnsValue) => a.type === b.type && absolute(a.name) === absolute(b.name)
  && normalizeValue(a.type, a.value) === normalizeValue(b.type, b.value);

/**
 * Compares the required records with a zone's records. Creates and changes to records in `owned` (the ledger of
 * records Postreeve created) are selected by default; anything touching another record starts unselected.
 */
export function planChanges(required: readonly DnsValue[], current: readonly ProviderRecord[], owned: ReadonlySet<string>): Plan {
  const requiredNames = new Set(required.map(({ name }) => absolute(name)));
  const isOwned = (record: DnsValue) => owned.has(recordKey(record));
  // Only records at the names the checklist covers are Postreeve's business, plus anything it created itself.
  const relevant = current.filter((record) => requiredNames.has(record.name) || isOwned(record));
  const used = new Set<string>();
  const changes: PlannedChange[] = [];
  let inSync = 0;

  for (const want of required) {
    const exact = relevant.find((record) => !used.has(record.id) && sameValue(record, want));
    if (exact) {
      used.add(exact.id);
      inSync += 1;
      continue;
    }
    const slot = relevant.find((record) => !used.has(record.id) && record.type === want.type && record.name === absolute(want.name)
      && (want.type === "CNAME" || want.type === "SRV" || (want.type === "TXT" && txtKind(record.value) !== null && txtKind(record.value) === txtKind(want.value))));
    if (slot) {
      used.add(slot.id);
      const mine = isOwned(slot);
      changes.push(change("update", want, slot, want, mine, mine
        ? "Postreeve created this record; it now needs the new value"
        : "Not created by Postreeve; tick it to replace its value"));
    } else {
      changes.push(change("create", want, null, want, true, "Required by the mail server and missing"));
    }
  }

  for (const record of relevant.filter((candidate) => !used.has(candidate.id))) {
    const mine = isOwned(record);
    const conflicts = required.some((want) => want.name === record.name && want.type === record.type
      && (record.type !== "TXT" || (txtKind(record.value) !== null && txtKind(record.value) === txtKind(want.value))));
    if (!mine && !conflicts) continue;
    changes.push(change("delete", record, record, null, mine, mine
      ? (requiredNames.has(record.name) && conflicts ? "Postreeve created this record and it conflicts with a required one" : "Postreeve created this record and the mail server no longer needs it")
      : record.type === "MX" ? "Not created by Postreeve; mail for this name would also go to another server. Tick it to remove"
      : "Not created by Postreeve; a second record of this kind conflicts with the required one. Tick it to remove"));
  }

  // Creates and updates first, then deletes, so a name is never left without its record.
  changes.sort((a, b) => (a.action === "delete" ? 1 : 0) - (b.action === "delete" ? 1 : 0));
  const fingerprint = hash(JSON.stringify({
    required: required.map(recordKey).sort(),
    current: relevant.map((record) => `${record.id}=${recordKey(record)}`).sort(),
  }));
  return { changes, inSync, fingerprint };
}

function change(action: DnsChange["action"], subject: DnsValue, record: ProviderRecord | null, next: DnsValue | null, owned: boolean, reason: string): PlannedChange {
  const from = record ? record.value : null;
  const to = next ? next.value : null;
  return {
    id: hash(`${action}|${subject.type}|${absolute(subject.name)}|${from ?? ""}|${to ?? ""}|${record?.id ?? ""}`).slice(0, 16),
    action, type: subject.type, name: absolute(subject.name), from, to, owned, selected: owned, reason, record, next,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
