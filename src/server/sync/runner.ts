import type { MailProviderRegistry } from "../mail/provider";
import { additiveSynchronization, SynchronizationError, syncScopeSchema } from "../mail/synchronization";
import type { SynchronizationStore, SyncClaim } from "./store";

export interface SynchronizationOptions {
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly pageLimit?: number;
  readonly maxScopes?: number;
}

export class SynchronizationRunner {
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #leaseMs: number;
  readonly #pageLimit: number;
  readonly #maxScopes: number;
  readonly #active = new Map<string, { claim: SyncClaim; controller: AbortController }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  #running: Promise<boolean> | undefined;

  constructor(readonly store: SynchronizationStore, readonly tenantId: string, readonly providers: MailProviderRegistry, options: SynchronizationOptions = {}) {
    if (!tenantId.trim()) throw new Error("Synchronization requires a tenant");
    this.#now = options.now ?? Date.now;
    this.#pollMs = positive(options.pollMs ?? 60_000);
    this.#leaseMs = positive(options.leaseMs ?? 120_000);
    this.#pageLimit = positive(options.pageLimit ?? 100);
    this.#maxScopes = positive(options.maxScopes ?? 1_000);
  }

  schedule(accountId: string, replace = false): void {
    if (replace) this.#active.get(accountId)?.controller.abort();
    this.store.schedule(this.tenantId, accountId, this.#now(), replace);
  }
  cancel(accountId: string): void {
    this.store.cancel(this.tenantId, accountId, this.#now());
    this.#active.get(accountId)?.controller.abort();
  }
  retry(accountId: string): void {
    this.#active.get(accountId)?.controller.abort();
    this.store.retry(this.tenantId, accountId, this.#now());
  }
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#scheduleTick(0);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    for (const { claim, controller } of this.#active.values()) {
      this.store.release(claim, this.#now());
      controller.abort();
    }
    await this.#running;
  }
  runOnce(): Promise<boolean> {
    if (this.#running) return this.#running;
    const running = this.#run();
    this.#running = running;
    const clear = () => { if (this.#running === running) this.#running = undefined; };
    void running.then(clear, clear);
    return running;
  }
  #scheduleTick(delay: number): void {
    this.#timer = setTimeout(() => {
      void this.runOnce().then(worked => {
        if (!this.#stopped) this.#scheduleTick(worked ? 0 : 1_000);
      }, () => { if (!this.#stopped) this.#scheduleTick(1_000); });
    }, delay);
    this.#timer.unref();
  }
  async #run(): Promise<boolean> {
    const claim = this.store.claim(this.tenantId, this.#now(), this.#leaseMs);
    if (!claim) return false;
    const controller = new AbortController();
    this.#active.set(claim.accountId, { claim, controller });
    const timeout = setTimeout(() => controller.abort(), this.#leaseMs);
    timeout.unref();
    try {
      await this.#execute(claim, controller.signal);
    } catch (error) {
      const job = this.store.jobs(this.tenantId).find(job => job.account_id === claim.accountId);
      const retryMs = Math.min(this.#pollMs * 2 ** Math.min(job?.attempts ?? 0, 6), 3_600_000);
      this.store.fail(claim, this.#now(), error instanceof SynchronizationError ? error.kind : "provider", retryMs);
    } finally {
      clearTimeout(timeout);
      if (this.#active.get(claim.accountId)?.controller === controller) this.#active.delete(claim.accountId);
    }
    return true;
  }
  async #execute(claim: SyncClaim, signal: AbortSignal): Promise<void> {
    const provider = this.providers.forAccount(claim.accountId);
    const ingestion = provider.synchronization ?? additiveSynchronization(provider);
    const scopes = await abortable(ingestion.discoverScopes(claim, signal), signal);
    signal.throwIfAborted();
    this.store.discover(claim, scopes, this.#now(), this.#maxScopes);
    const scope = this.store.scopes(claim).find(scope => scope.due_at <= this.#now());
    if (scope) {
      const parsed = syncScopeSchema.parse(JSON.parse(scope.scope));
      const page = await abortable(ingestion.fetchPage({ account: claim, scope: parsed, cursor: scope.cursor,
        limit: this.#pageLimit, signal }), signal);
      signal.throwIfAborted();
      try {
        this.store.commit(claim, parsed, page, this.#now(), this.#pollMs, this.#pageLimit);
      } catch { throw new SynchronizationError("invalid-data"); }
    }
    this.store.finish(claim, this.#now(), this.#pollMs);
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error("Synchronization canceled"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([operation, abort]); }
  finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Synchronization limits must be positive integers");
  return value;
}
