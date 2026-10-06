import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { AccountHealth, Reauthorization } from "../shared/synchronization";

const labels: Record<AccountHealth["state"], string> = {
  healthy: "Healthy", "catching-up": "Catching up", degraded: "Degraded",
  disconnected: "Disconnected", "reauthorization-required": "Reauthorization required",
};
const time = (value: number | null) => value === null ? "Not yet" : new Date(value).toLocaleString();

export function SyncStorageView({ googleConfigured, onManageAccount }: {
  googleConfigured: boolean; onManageAccount: (accountId: string) => void;
}) {
  const client = useQueryClient();
  const [authorization, setAuthorization] = useState<Reauthorization | null>(null);
  const status = useQuery({ queryKey: ["synchronization"], queryFn: ({ signal }) => api.synchronization(signal), refetchInterval: 5_000 });
  const retry = useMutation({ mutationFn: (id: string) => api.retrySynchronization(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["synchronization"] }) });
  const reauthorize = useMutation({ mutationFn: (id: string) => api.requestReauthorization(id), onSuccess: setAuthorization });
  return <>
    <div className="toolbar"><span className="scope-title">Sync & storage</span>
      <button className="btn-quiet" onClick={() => void status.refetch()}>Refresh health</button></div>
    <div className="readscroll"><div className="pad">
      {status.isPending ? <p role="status">Loading synchronization health…</p> : null}
      {status.error ? <p role="alert">Could not load synchronization health. Use Refresh health to retry.</p> : null}
      {retry.error || reauthorize.error ? <p role="alert">Recovery request failed. Refresh health and try again.</p> : null}
      {status.data ? <>
        <p className="t-body">Background synchronization continues while the server runs, even with this page closed.</p>
        <p className="t-body">Cached preview content expires {status.data.retention.maxAgeDays} days after its last refresh.
          Each account retains at most {Math.round(status.data.retention.maxContentBytes / 1024 / 1024 * 100) / 100} MiB of preview text;
          the oldest previews expire first. Message headers, locations, conversation identities and proposal history remain available.
          This limits disposable content, not the total database size. Message bodies are fetched on demand. Provider mail is unchanged.</p>
        {status.data.accounts.map(health => <section key={health.account.id} style={{ padding: "18px 0", borderTop: "1px solid var(--line)" }}>
          <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>{health.account.email} · {labels[health.state]}</h3>
          <p className="t-body">{health.guidance}</p>
          <p className="t-dim">Last successful sync: {time(health.lastSuccessAt)} · Coverage: {health.coverage}
            {" · "}Retained previews: {health.retainedContentBytes.toLocaleString()} bytes</p>
          {health.failure ? <p className="t-body">Latest failure ({time(health.failure.at)}): {health.failure.message}</p> : null}
          {health.nextAttemptAt !== null ? <p className="t-dim">Next attempt: {time(health.nextAttemptAt)}</p> : null}
          <div style={{ display: "flex", gap: 16 }}>
            <button className="btn" disabled={!health.retryAvailable || retry.isPending} onClick={() => retry.mutate(health.account.id)}>Retry synchronization</button>
            <button className="btn-quiet" disabled={reauthorize.isPending} onClick={() => reauthorize.mutate(health.account.id)}>Reauthorize account</button>
          </div>
          {retry.isSuccess && retry.data.account.id === health.account.id ? <p role="status">{retry.data.state === "disconnected" ? retry.data.guidance : "Retry requested. Health updates after synchronization makes progress."}</p> : null}
          {authorization?.accountId === health.account.id ? <div role="status">
            <p>{authorization.instructions}</p>
            {authorization.method === "google-consent"
              ? googleConfigured ? <a className="btn" href="/api/oauth/google/start">Continue with Google</a> : <p>Google OAuth is not configured on this server.</p>
              : <button className="btn" onClick={() => onManageAccount(health.account.id)}>Manage account</button>}
          </div> : null}
        </section>)}
      </> : null}
    </div></div>
  </>;
}
