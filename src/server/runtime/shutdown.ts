export interface ShutdownParts {
  /** Bun's `server.stop`: `false` stops accepting and waits for in-flight requests, `true` drops them. */
  readonly server: { stop(closeActiveConnections?: boolean): Promise<void> | void };
  /** Ends long-lived responses such as the mailbox event stream, which would otherwise never finish. */
  readonly endStreams: () => void;
  /** Stops synchronization, including IMAP IDLE connections, and waits for the running pass. */
  readonly stopSynchronization: () => Promise<void>;
  /** Closes the database after every writer has finished. */
  readonly closeStore: () => void;
  readonly drainTimeoutMs: number;
  readonly log?: (message: string) => void;
}

/**
 * Builds an idempotent shutdown: stop accepting requests, end event streams, let in-flight
 * requests and the synchronization pass finish (bounded by the drain timeout), then close the store.
 */
export function createShutdown(parts: ShutdownParts): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= run(parts);
    return shutdown;
  };
}

async function run(parts: ShutdownParts): Promise<void> {
  const log = parts.log ?? (() => undefined);
  log("Postreeve is shutting down");
  const draining = Promise.resolve(parts.server.stop(false));
  parts.endStreams();
  const settled = Promise.allSettled([draining, parts.stopSynchronization()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    settled.then(() => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), parts.drainTimeoutMs); }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    log(`Requests or synchronization did not finish within ${parts.drainTimeoutMs} ms; closing connections`);
    await parts.server.stop(true);
  }
  parts.closeStore();
  log("Postreeve stopped");
}
