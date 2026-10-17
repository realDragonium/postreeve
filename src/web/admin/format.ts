import type { DnsCheck, DnsRecordCategory, QueuedRecipient } from "../../shared/mail-server";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unlimited";
  if (bytes >= GIB) return `${Number((bytes / GIB).toFixed(2))} GiB`;
  if (bytes >= MIB) return `${Number((bytes / MIB).toFixed(1))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** Reads a quota typed in GiB; blank means unlimited. Returns undefined for input that is not a positive number. */
export function parseQuotaGib(value: string): number | null | undefined {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return null;
  const gib = Number(trimmed);
  if (!Number.isFinite(gib) || gib <= 0) return undefined;
  return Math.round(gib * GIB);
}

export function quotaToGib(bytes: number | null): string {
  return bytes === null ? "" : String(Number((bytes / GIB).toFixed(3)));
}

export const categoryLabels: Record<DnsRecordCategory, string> = {
  mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC", "mta-sts": "MTA-STS", "tls-rpt": "TLS-RPT",
  autoconfig: "Autoconfig", autodiscover: "Autodiscover", srv: "SRV", caa: "CAA", other: "Other",
};

const categoryOrder: readonly DnsRecordCategory[] = ["mx", "spf", "dkim", "dmarc", "mta-sts", "tls-rpt", "autoconfig", "autodiscover", "srv", "caa", "other"];

/** Delivery-critical records first, in the order a person usually publishes them. */
export function sortChecks(checks: readonly DnsCheck[]): DnsCheck[] {
  return [...checks].sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category));
}

export const dnsStatusLabels: Record<DnsCheck["status"], string> = { ok: "OK", missing: "Missing", different: "Different", error: "Lookup failed" };

export const recipientStatusLabels: Record<QueuedRecipient["status"], string> = {
  scheduled: "Scheduled", completed: "Delivered", temporaryFailure: "Deferred", permanentFailure: "Failed",
};

/** Accepts addresses separated by commas, spaces or new lines. */
export function parseAddressList(value: string): string[] | null {
  const addresses = value.split(/[\s,;]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  return addresses.every((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) ? [...new Set(addresses)] : null;
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
