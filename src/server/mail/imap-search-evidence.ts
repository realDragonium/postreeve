import type { ESearchResult } from "imapflow";
import { imapSearchUids } from "./imap-search-result";
import { SynchronizationError } from "./synchronization";

// ImapFlow synthesizes SEARCH counts after dropping invalid entries. Its public
// logger is the last observable boundary that retains response presence and loss.
export class ImapSearchEvidence {
  #active: { tag: string; seen: boolean; esearch: boolean; requireCount: boolean; plainModseq: boolean } | undefined;
  #invalid = false;
  readonly logger = {
    debug: (entry: unknown) => this.#observe(entry),
    info: () => {},
    warn: (entry: unknown) => this.#observe(entry),
    error: (entry: unknown) => this.#observe(entry, true),
    trace: () => {},
    fatal: (entry: unknown) => this.#observe(entry, true),
  };

  assertComplete(): void {
    if (this.#invalid || this.#active) throw new SynchronizationError("invalid-data");
  }

  #observe(entry: unknown, error = false): void {
    if (!entry || typeof entry !== "object") return;
    const msg = "msg" in entry && typeof entry.msg === "string" ? entry.msg : "";
    const src = "src" in entry ? entry.src : undefined;
    if (src === "c") {
      const command = /^(\S+) UID SEARCH(?: |$)/.exec(msg);
      if (command) {
        if (this.#active) this.#invalid = true;
        this.#active = { tag: command[1]!, seen: false, esearch: false, plainModseq: false, requireCount: / RETURN \([^)]*\bCOUNT\b/i.test(msg) };
      }
      return;
    }
    const active = this.#active;
    if (!active) return;
    if (error || ("discarded" in entry && entry.discarded === true && !active.plainModseq)
      || ("truncated" in entry && entry.truncated === true)
      || ("nullBytesRemoved" in entry && typeof entry.nullBytesRemoved === "number" && entry.nullBytesRemoved > 0)) {
      this.#invalid = true;
    }
    if (src !== "s") return;
    if (msg.startsWith(`${active.tag} `)) {
      if (!active.seen || !/^OK(?: |$)/i.test(msg.slice(active.tag.length + 1))) this.#invalid = true;
      this.#active = undefined;
    } else if (/^\* SEARCH(?: |$)/i.test(msg)) {
      if (active.esearch) this.#invalid = true;
      active.seen = true;
      // The legacy parser warns when it skips valid MODSEQ metadata as a non-UID token.
      const metadata = / \(MODSEQ [1-9]\d{0,19}\)$/i;
      active.plainModseq = metadata.test(msg);
      const values = msg.slice(8).replace(metadata, "").trim();
      if (values && values.split(" ").some(value => !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 0xffff_ffff)) this.#invalid = true;
    } else if (/^\* ESEARCH(?: |$)/i.test(msg)) {
      if (active.seen) this.#invalid = true;
      active.seen = true;
      active.esearch = true;
      let values = msg.slice(9).trim();
      const correlator = /^\(TAG "([^"\\]+)"\) /i.exec(values);
      if (correlator) {
        if (correlator[1] !== active.tag) this.#invalid = true;
        values = values.slice(correlator[0].length);
      }
      if (!/^UID(?: |$)/i.test(values)) { this.#invalid = true; return; }
      const remainder = values.slice(3).trim();
      const tokens = remainder ? remainder.split(" ") : [];
      const keys = new Set<string>();
      const result: ESearchResult = {};
      for (let index = 0; index < tokens.length; index += 2) {
        const key = tokens[index]?.toUpperCase() ?? "";
        const value = tokens[index + 1] ?? "";
        const valid = key === "ALL" ? /^\d+(?::\d+)?(?:,\d+(?::\d+)?)*$/.test(value)
          : ["COUNT", "MIN", "MAX", "MODSEQ"].includes(key) && /^\d+$/.test(value);
        if (!valid || keys.has(key)) this.#invalid = true;
        keys.add(key);
        if (key === "ALL") result.all = value;
        else if (key === "COUNT") result.count = Number(value);
        else if (key === "MIN") result.min = Number(value);
        else if (key === "MAX") result.max = Number(value);
      }
      try { imapSearchUids(result, { limit: 0, requireCount: active.requireCount }); }
      catch { this.#invalid = true; }
    }
  }
}
