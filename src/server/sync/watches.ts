import type { MailProvider, MailProviderRegistry, ProviderWatch } from "../mail/provider";
import type { SyncJob } from "./store";

/** Keeps one provider change watch per account whose synchronization may run. */
export class ProviderWatches {
  readonly #watches = new Map<string, { provider: MailProvider; watch: ProviderWatch }>();

  constructor(readonly providers: MailProviderRegistry, readonly onChange: (accountId: string, mailbox: string) => void) {}

  reconcile(jobs: readonly SyncJob[]): void {
    const wanted = new Map<string, MailProvider>();
    for (const job of jobs) {
      if (job.state === "canceled" || job.provider_unavailable === 1 || (job.state === "retry" && job.error === "reauthorization")) continue;
      const provider = this.providers.get(job.account_id);
      if (provider?.watchChanges) wanted.set(job.account_id, provider);
    }
    for (const [accountId, entry] of this.#watches) {
      if (wanted.get(accountId) === entry.provider) continue;
      entry.watch.stop();
      this.#watches.delete(accountId);
    }
    for (const [accountId, provider] of wanted) {
      if (this.#watches.has(accountId)) continue;
      const watch = provider.watchChanges?.(mailbox => this.onChange(accountId, mailbox));
      if (watch) this.#watches.set(accountId, { provider, watch });
    }
  }

  stopAll(): void {
    for (const { watch } of this.#watches.values()) watch.stop();
    this.#watches.clear();
  }
}
