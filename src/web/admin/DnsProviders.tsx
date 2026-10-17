import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DnsChange, DnsPlan } from "../../shared/dns-providers";
import { Sheet } from "../panels";
import { mailServerApi as api } from "./api";
import { ConfirmSheet, ErrorLine } from "./common";

/** Connected DNS providers (Settings › Mail server › DNS providers). */
export function DnsProvidersPanel() {
  const client = useQueryClient();
  const providers = useQuery({ queryKey: ["dns-providers"], queryFn: () => api.dnsProviders() });
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["dns-providers"] });
  const disconnect = useMutation({ mutationFn: (id: string) => api.disconnectDnsProvider(id), onSuccess: async () => { setRemoving(null); await refresh(); } });
  return <section style={{ maxWidth: 820 }}>
    <p className="t-body" style={{ marginTop: 0 }}>Connect where your domains' DNS lives, and Postreeve can publish each domain's mail records for you.
      Every change is shown first and applied only after you confirm it; records Postreeve did not create are changed only when you tick them.</p>
    <ErrorLine error={providers.error} />
    {providers.data?.map((provider) => <div key={provider.id} style={{ padding: "10px 0", borderTop: "1px solid var(--div)", display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
      <span className="t-ink">{provider.name}</span>
      <span className="t-dim">{provider.kind === "cloudflare" ? "Cloudflare" : "GoDaddy"}</span>
      <span className="t-body">{provider.zones ? (provider.zones.length ? provider.zones.join(", ") : "no zones visible") : provider.error}</span>
      <button className="btn-danger" style={{ marginLeft: "auto" }} onClick={() => setRemoving(provider)}>Disconnect</button>
    </div>)}
    <div style={{ marginTop: 12 }}><button className="chip" onClick={() => setConnecting(true)}>Connect a DNS provider</button></div>
    {connecting ? <ConnectDnsSheet onClose={() => { setConnecting(false); void refresh(); }} /> : null}
    {removing ? <ConfirmSheet title={`Disconnect ${removing.name}`} action="Disconnect" pending={disconnect.isPending} error={disconnect.error}
      body="Postreeve forgets this provider, its credential and which records it created there. No DNS record changes."
      onConfirm={() => disconnect.mutate(removing.id)} onClose={() => setRemoving(null)} /> : null}
  </section>;
}

function ConnectDnsSheet({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<"cloudflare" | "godaddy">("cloudflare");
  const [name, setName] = useState("Cloudflare");
  const [token, setToken] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const connect = useMutation({
    mutationFn: () => api.connectDnsProvider({ name, credential: kind === "cloudflare" ? { kind, apiToken: token } : { kind, apiKey: key, apiSecret: secret } }),
    onSuccess: onClose,
  });
  return <Sheet title="Connect a DNS provider" onClose={onClose} closeDisabled={connect.isPending}
    onSubmit={(event) => { event.preventDefault(); connect.mutate(); }}
    footer={<><button type="submit" className="btn" disabled={connect.isPending}>{connect.isPending ? "Checking…" : "Check and connect"}</button>
      <button type="button" className="btn-quiet push" onClick={onClose}>Cancel</button></>}>
    <div style={{ display: "flex", gap: 6 }}>
      <button type="button" className="opt" aria-pressed={kind === "cloudflare"} onClick={() => { setKind("cloudflare"); setName("Cloudflare"); }}>Cloudflare</button>
      <button type="button" className="opt" aria-pressed={kind === "godaddy"} onClick={() => { setKind("godaddy"); setName("GoDaddy"); }}>GoDaddy</button>
    </div>
    <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></label>
    {kind === "cloudflare" ? <>
      <label className="field"><span className="field-label">API token</span><input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required /></label>
      <p className="t-dim" style={{ margin: 0 }}>Create it under My Profile › API Tokens with the permission Zone › DNS › Edit, limited to the zones of your mail domains.</p>
    </> : <>
      <div className="field-grid">
        <label className="field"><span className="field-label">API key</span><input className="input" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} required /></label>
        <label className="field"><span className="field-label">API secret</span><input className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} required /></label>
      </div>
      <p className="t-dim" style={{ margin: 0 }}>Create a production key at developer.godaddy.com. GoDaddy limits its DNS API to some accounts; if yours is refused, Postreeve keeps showing the records to copy by hand.</p>
    </>}
    <ErrorLine error={connect.error} />
  </Sheet>;
}

/** The provider diff for one domain, shown above the checklist in the DNS tab. */
export function DnsPlanPanel({ serverId, domainId }: { serverId: string; domainId: string }) {
  const client = useQueryClient();
  const plan = useQuery({ queryKey: ["dns-plan", serverId, domainId], queryFn: () => api.dnsPlan(serverId, domainId) });
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState(false);
  const data = plan.data;
  const isPicked = (change: DnsChange) => picked[change.id] ?? change.selected;
  const chosen = data?.changes.filter(isPicked) ?? [];
  const apply = useMutation({
    mutationFn: () => api.dnsApply(serverId, domainId, data!.fingerprint, chosen.map(({ id }) => id)),
    onSuccess: async () => {
      setConfirming(false);
      setPicked({});
      await client.invalidateQueries({ queryKey: ["dns-plan", serverId, domainId] });
      await client.invalidateQueries({ queryKey: ["mail-server-dns", serverId, domainId] });
    },
  });
  if (plan.isPending) return <p className="t-dim">Checking your DNS provider…</p>;
  if (plan.error) return <ErrorLine error={plan.error} />;
  if (!data || data.status === "no-provider") return <p className="t-dim">{data?.reason ?? "No DNS provider"}. Connect one under DNS providers to publish these records from here, or copy them below.</p>;
  if (data.status === "unavailable") return <p className="alert" role="status">{data.reason}</p>;
  return <section style={{ marginBottom: 18 }}>
    <div style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
      <span className="t-sec">{data.providerName} · zone {data.zone}</span>
      <span className="t-dim">{data.inSync} in sync · {data.changes.length} change{data.changes.length === 1 ? "" : "s"}</span>
      {data.changes.length ? <button className="btn" style={{ marginLeft: "auto" }} disabled={chosen.length === 0} onClick={() => setConfirming(true)}>Review and apply {chosen.length}</button> : null}
    </div>
    {data.changes.length === 0 ? <p className="t-body">Every record this provider can publish matches the mail server.</p> : null}
    {data.changes.map((change) => <ChangeRow key={change.id} change={change} picked={isPicked(change)} onPick={(value) => setPicked({ ...picked, [change.id]: value })} />)}
    {data.manual.length ? <p className="t-dim">{data.manual.length} record{data.manual.length === 1 ? "" : "s"} ({[...new Set(data.manual.map(({ type }) => type))].join(", ")}) must be published by hand; see the checklist below.</p> : null}
    {apply.data ? <div role="status">{apply.data.results.filter(({ ok }) => !ok).map(({ id, message }) => <p key={id} className="alert error">{message}</p>)}</div> : null}
    {confirming ? <ConfirmSheet title={`Apply ${chosen.length} DNS change${chosen.length === 1 ? "" : "s"} at ${data.providerName}`} action="Apply changes" pending={apply.isPending} error={apply.error}
      body={<PlanSummary plan={data} chosen={chosen} />} onConfirm={() => apply.mutate()} onClose={() => setConfirming(false)} /> : null}
  </section>;
}

function ChangeRow({ change, picked, onPick }: { change: DnsChange; picked: boolean; onPick: (value: boolean) => void }) {
  return <label className="grid-row" style={{ "--grid-cols": "24px 64px 56px minmax(0,1fr)", height: "auto", alignItems: "start", padding: "6px 0", cursor: "pointer" } as React.CSSProperties}>
    <input type="checkbox" checked={picked} onChange={(event) => onPick(event.target.checked)} aria-label={`${change.action} ${change.type} ${change.name}`} />
    <span className={change.action === "delete" ? "t-ink" : "t-body"} style={{ fontWeight: 600 }}>{change.action}</span>
    <span className="t-dim">{change.type}</span>
    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <span className="t-ink">{change.name}</span>
      {change.from ? <span className="t-dim" style={{ display: "block" }}>− {change.from}</span> : null}
      {change.to ? <span className="t-body" style={{ display: "block" }}>+ {change.to}</span> : null}
      <span className="t-dim" style={{ display: "block" }}>{change.reason}</span>
    </span>
  </label>;
}

function PlanSummary({ plan, chosen }: { plan: DnsPlan; chosen: readonly DnsChange[] }) {
  const foreign = chosen.filter(({ owned, action }) => !owned && action !== "create");
  return <>
    <p style={{ marginTop: 0 }}>Postreeve will write these records at {plan.providerName} for {plan.zone}. DNS changes reach the internet within minutes; each record gets a TTL of 5 minutes (10 at GoDaddy).</p>
    <ul style={{ paddingLeft: 18 }}>{chosen.map((change) => <li key={change.id}>{change.action} {change.type} {change.name}{change.to ? ` → ${change.to.length > 80 ? `${change.to.slice(0, 80)}…` : change.to}` : ""}</li>)}</ul>
    {foreign.length ? <p className="alert error">{foreign.length} of these change{foreign.length === 1 ? "s" : ""} a record Postreeve did not create.</p> : null}
  </>;
}
