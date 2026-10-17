import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describeOperation,
  requiredConfirmations,
  type MailServerProposal,
  type MailServerSummary,
  type SpamListName,
  type SpamSettings,
} from "../../shared/mail-server";
import { Sheet } from "../panels";
import { ConfirmSheet, ErrorLine, Toolbar } from "./common";
import { mailServerApi as api } from "./api";
import { DomainsPanel } from "./DomainsPanel";
import { formatBytes, formatDate, recipientStatusLabels } from "./format";

const tabs = ["Domains", "Queue", "Reports", "Spam", "Proposals"] as const;
type Tab = (typeof tabs)[number];

export function MailServerView() {
  const client = useQueryClient();
  const servers = useQuery({ queryKey: ["mail-servers"], queryFn: () => api.list() });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [tab, setTab] = useState<Tab>("Domains");
  const proposals = useQuery({ queryKey: ["mail-server-proposals"], queryFn: () => api.proposals(), refetchInterval: 30_000 });
  const list = servers.data ?? [];
  const selected = list.find(({ id }) => id === selectedId) ?? list[0] ?? null;
  const pending = (proposals.data ?? []).filter((proposal) => proposal.status === "pending" && proposal.serverId === selected?.id);

  if (servers.isPending) return <><Toolbar title="Mail server" /><div className="readscroll"><div className="pad"><p role="status">Loading mail servers…</p></div></div></>;

  return <>
    <Toolbar title="Mail server" meta={selected ? `${selected.name} · ${selected.domainCount ?? "?"} domains` : "No server connected"}
      action={<button className="btn-quiet" onClick={() => setConnecting(true)}>Connect a server</button>} />
    <div className="readscroll"><div className="pad">
      <ErrorLine error={servers.error} />
      {list.length === 0 ? <Intro onConnect={() => setConnecting(true)} /> : null}
      {list.length > 1 ? <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {list.map((server) => <button key={server.id} className="opt" aria-pressed={server.id === selected?.id} onClick={() => setSelectedId(server.id)}>{server.name}</button>)}
      </div> : null}
      {selected ? <>
        <ServerHeader server={selected} onRemoved={() => { setSelectedId(null); void client.invalidateQueries({ queryKey: ["mail-servers"] }); }} />
        <div className="tabs" role="tablist" style={{ margin: "18px 0 14px" }}>
          {tabs.map((name) => <button key={name} role="tab" className="opt" aria-pressed={tab === name} onClick={() => setTab(name)}>
            {name}{name === "Proposals" && pending.length ? ` · ${pending.length}` : ""}</button>)}
        </div>
        {tab === "Domains" ? <DomainsPanel server={selected} /> : null}
        {tab === "Queue" ? <QueuePanel serverId={selected.id} /> : null}
        {tab === "Reports" ? <ReportsPanel serverId={selected.id} /> : null}
        {tab === "Spam" ? <SpamPanel serverId={selected.id} /> : null}
        {tab === "Proposals" ? <ProposalsPanel proposals={(proposals.data ?? []).filter(({ serverId }) => serverId === selected.id)} /> : null}
      </> : null}
    </div></div>
    {connecting ? <ConnectSheet onClose={() => setConnecting(false)} onConnected={(id) => { setConnecting(false); setSelectedId(id); }} /> : null}
  </>;
}

function Intro({ onConnect }: { onConnect: () => void }) {
  return <div style={{ maxWidth: 720 }}>
    <p className="t-body">Connect a Stalwart Mail Server (v0.16 or later) to manage its domains, mailboxes, aliases, DKIM keys and DNS
      records, watch its delivery queue, and add new mailboxes to Postreeve in one step.</p>
    <p className="t-body">Create an API key for Postreeve in Stalwart's web admin under your admin account, then enter the admin URL your
      Postreeve server can reach, such as its tailnet address. The key is encrypted with the same key as your mailbox passwords and never shown again.</p>
    <button className="chip" onClick={onConnect}>Connect a server</button>
  </div>;
}

function ConnectSheet({ onClose, onConnected }: { onClose: () => void; onConnected: (id: string) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("Mail server");
  const [baseUrl, setBaseUrl] = useState("");
  const [kind, setKind] = useState<"apiKey" | "basic">("apiKey");
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mailHostname, setMailHostname] = useState("");
  const connect = useMutation({
    mutationFn: () => api.connect({
      name, baseUrl, ...(mailHostname.trim() ? { mailHostname } : {}),
      credential: kind === "apiKey" ? { kind, apiKey } : { kind, username, password },
    }),
    onSuccess: async (server) => { await client.invalidateQueries({ queryKey: ["mail-servers"] }); onConnected(server.id); },
  });
  return <Sheet title="Connect a Stalwart server" onClose={onClose} closeDisabled={connect.isPending}
    onSubmit={(event) => { event.preventDefault(); connect.mutate(); }}
    footer={<><button type="submit" className="btn" disabled={connect.isPending}>{connect.isPending ? "Testing…" : "Test and connect"}</button>
      <button type="button" className="btn-quiet push" onClick={onClose}>Cancel</button></>}>
    <div className="field-grid">
      <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label className="field"><span className="field-label">Admin URL</span><input className="input" value={baseUrl} placeholder="https://mail-admin.your-tailnet.ts.net" onChange={(e) => setBaseUrl(e.target.value)} required /></label>
    </div>
    <div style={{ display: "flex", gap: 6 }}>
      <button type="button" className="opt" aria-pressed={kind === "apiKey"} onClick={() => setKind("apiKey")}>API key</button>
      <button type="button" className="opt" aria-pressed={kind === "basic"} onClick={() => setKind("basic")}>Admin login</button>
    </div>
    {kind === "apiKey"
      ? <label className="field"><span className="field-label">API key</span><input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required /></label>
      : <div className="field-grid">
        <label className="field"><span className="field-label">Admin username</span><input className="input" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label className="field"><span className="field-label">Password</span><input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      </div>}
    <label className="field"><span className="field-label">Mail hostname (optional)</span>
      <input className="input" value={mailHostname} placeholder="Defaults to the hostname Stalwart announces" onChange={(e) => setMailHostname(e.target.value)} /></label>
    <p className="t-dim" style={{ margin: 0 }}>Plain http:// is accepted only for loopback, private-network and Tailscale addresses. An API key can be revoked in Stalwart without changing your admin password.</p>
    <ErrorLine error={connect.error} />
  </Sheet>;
}

function ServerHeader({ server, onRemoved }: { server: MailServerSummary; onRemoved: () => void }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const disconnect = useMutation({ mutationFn: () => api.disconnect(server.id), onSuccess: () => { setRemoving(false); onRemoved(); } });
  return <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
    <span style={{ fontSize: 13, fontWeight: 600 }}>{server.name}</span>
    <span className="t-body">{server.baseUrl}</span>
    <span className="t-dim">mail host {server.mailHostname} · {server.credentialKind === "apiKey" ? "API key" : "admin login"}</span>
    {server.error ? <span className="alert error" role="alert">{server.error}</span> : null}
    <span style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
      <a className="btn-quiet" href={server.baseUrl} target="_blank" rel="noreferrer">Open Stalwart admin</a>
      <button className="btn-quiet" onClick={() => setEditing(true)}>Edit</button>
      <button className="btn-danger" onClick={() => setRemoving(true)}>Disconnect</button>
    </span>
    {editing ? <EditServerSheet server={server} onClose={() => { setEditing(false); void client.invalidateQueries({ queryKey: ["mail-servers"] }); }} /> : null}
    {removing ? <ConfirmSheet title={`Disconnect ${server.name}`} action="Disconnect" pending={disconnect.isPending} error={disconnect.error}
      body="Postreeve forgets this server and its credential. Nothing changes on the mail server, and Postreeve accounts for its mailboxes keep working."
      onConfirm={() => disconnect.mutate()} onClose={() => setRemoving(false)} /> : null}
  </div>;
}

function EditServerSheet({ server, onClose }: { server: MailServerSummary; onClose: () => void }) {
  const [name, setName] = useState(server.name);
  const [mailHostname, setMailHostname] = useState(server.mailHostname);
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: () => api.update(server.id, { name, mailHostname, ...(apiKey ? { credential: { kind: "apiKey" as const, apiKey } } : {}) }),
    onSuccess: onClose,
  });
  return <Sheet title={`Edit ${server.name}`} onClose={onClose} closeDisabled={save.isPending}
    onSubmit={(event) => { event.preventDefault(); save.mutate(); }}
    footer={<><button type="submit" className="btn" disabled={save.isPending}>Save</button><button type="button" className="btn-quiet push" onClick={onClose}>Cancel</button></>}>
    <div className="field-grid">
      <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span className="field-label">Mail hostname for IMAP and SMTP</span><input className="input" value={mailHostname} onChange={(e) => setMailHostname(e.target.value)} /></label>
    </div>
    <label className="field"><span className="field-label">Replace API key (leave blank to keep)</span>
      <input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
    <ErrorLine error={save.error} />
  </Sheet>;
}

function QueuePanel({ serverId }: { serverId: string }) {
  const client = useQueryClient();
  const queue = useQuery({ queryKey: ["mail-server-queue", serverId], queryFn: () => api.queue(serverId), refetchInterval: 15_000 });
  const [cancelling, setCancelling] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["mail-server-queue", serverId] });
  const retry = useMutation({ mutationFn: (id: string) => api.retry(serverId, id), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancel(serverId, id), onSuccess: async () => { setCancelling(null); await refresh(); } });
  const messages = queue.data ?? [];
  return <section>
    <p className="t-body" style={{ marginTop: 0 }}>{queue.isPending ? "Loading the queue…" : messages.length ? `${messages.length} message${messages.length === 1 ? "" : "s"} waiting for delivery.` : "The delivery queue is empty."}</p>
    <ErrorLine error={queue.error ?? retry.error} />
    {messages.map((message) => <div key={message.id} style={{ padding: "12px 0", borderTop: "1px solid var(--div)" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="t-ink">{message.from}</span>
        <span className="t-dim">{formatBytes(message.size)} · queued {formatDate(message.createdAt)} · next try {formatDate(message.nextRetry)}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
          <button className="btn-quiet" disabled={retry.isPending} onClick={() => retry.mutate(message.id)}>Retry now</button>
          <button className="btn-danger" onClick={() => setCancelling(message.id)}>Cancel</button>
        </span>
      </div>
      {message.recipients.map((recipient) => <div key={recipient.address} className="t-body" style={{ paddingLeft: 12 }}>
        {recipient.address} · {recipientStatusLabels[recipient.status]} · {recipient.retryCount} attempt{recipient.retryCount === 1 ? "" : "s"}
        {recipient.lastError ? <span className="t-dim"> · {recipient.lastError}</span> : null}
      </div>)}
    </div>)}
    {cancelling ? <ConfirmSheet title="Cancel delivery" action="Cancel delivery" pending={cancel.isPending} error={cancel.error}
      body="Stalwart removes this message from the queue and does not try again. The sender is not notified by Postreeve."
      onConfirm={() => cancel.mutate(cancelling)} onClose={() => setCancelling(null)} /> : null}
  </section>;
}

function ReportsPanel({ serverId }: { serverId: string }) {
  const reports = useQuery({ queryKey: ["mail-server-reports", serverId], queryFn: () => api.reports(serverId) });
  return <section>
    <p className="t-body" style={{ marginTop: 0 }}>DMARC aggregate and TLS reports other providers sent about mail from your domains.</p>
    <ErrorLine error={reports.error} />
    {reports.data?.length === 0 ? <p className="t-dim">No reports received yet. They arrive daily once the DMARC and TLS-RPT records point at a mailbox here.</p> : null}
    {reports.data?.length ? <div style={{ "--grid-cols": "60px minmax(0,1fr) minmax(0,1fr) 180px 110px" } as React.CSSProperties}>
      <div className="grid-head"><span className="t-sec">Kind</span><span className="t-sec">Reporter</span><span className="t-sec">Domain</span><span className="t-sec">Period</span><span className="t-sec">Result</span></div>
      {reports.data.map((report) => <div className="grid-row" key={`${report.kind}-${report.id}`}>
        <span className="t-ink">{report.kind === "dmarc" ? "DMARC" : "TLS"}</span>
        <span className="t-body truncate" title={report.subject}>{report.reporter}</span>
        <span className="t-body truncate">{report.domain}</span>
        <span className="t-dim">{report.rangeStart?.slice(0, 10) ?? "?"} – {report.rangeEnd?.slice(0, 10) ?? "?"}</span>
        <span className={report.fail ? "t-ink" : "t-body"}>{report.pass} pass · {report.fail} fail</span>
      </div>)}
    </div> : null}
  </section>;
}

function SpamPanel({ serverId }: { serverId: string }) {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["mail-server-spam", serverId], queryFn: () => api.spam(serverId) });
  return <section>
    <ErrorLine error={settings.error} />
    {settings.data ? <SpamSettingsForm serverId={serverId} settings={settings.data} onSaved={() => client.invalidateQueries({ queryKey: ["mail-server-spam", serverId] })} /> : null}
    <div className="field-grid" style={{ marginTop: 24 }}>
      <SpamList serverId={serverId} list="trusted" title="Trusted sender domains" hint="Mail from these domains is never scored as spam. Stalwart ships several hundred defaults." />
      <SpamList serverId={serverId} list="blocked" title="Blocked sender domains" hint="Mail from these domains is always treated as spam." />
    </div>
    <p className="t-dim" style={{ margin: "20px 0 0" }}>Rules, DNSBLs, training and greylisting stay in Stalwart's own admin.</p>
  </section>;
}

function SpamSettingsForm({ serverId, settings, onSaved }: { serverId: string; settings: SpamSettings; onSaved: () => void }) {
  const [draft, setDraft] = useState(settings);
  const save = useMutation({ mutationFn: () => api.updateSpam(serverId, draft), onSuccess: onSaved });
  const number = (key: "spamThreshold" | "rejectThreshold" | "discardThreshold", label: string) =>
    <label className="field"><span className="field-label">{label}</span>
      <input className="input t-num" type="number" min={0} step={0.5} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} /></label>;
  return <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }} style={{ maxWidth: 720 }}>
    <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Spam filter on</label>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 12 }}>
      {number("spamThreshold", "Move to Junk above")}
      {number("rejectThreshold", "Reject above (0 = off)")}
      {number("discardThreshold", "Discard above (0 = off)")}
    </div>
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
      <button className="btn" type="submit" disabled={save.isPending}>Save spam settings</button>
      {save.isSuccess ? <span className="t-dim" role="status">Saved</span> : null}
    </div>
    <ErrorLine error={save.error} />
  </form>;
}

function SpamList({ serverId, list, title, hint }: { serverId: string; list: SpamListName; title: string; hint: string }) {
  const client = useQueryClient();
  const entries = useQuery({ queryKey: ["mail-server-spam-list", serverId, list], queryFn: () => api.spamList(serverId, list) });
  const [filter, setFilter] = useState("");
  const [domain, setDomain] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ["mail-server-spam-list", serverId, list] });
  const add = useMutation({ mutationFn: () => api.addSpamEntry(serverId, list, domain), onSuccess: async () => { setDomain(""); await refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.removeSpamEntry(serverId, list, id), onSuccess: refresh });
  const shown = (entries.data ?? []).filter((entry) => entry.domain.includes(filter.trim().toLowerCase()));
  return <div>
    <div className="t-sec" style={{ marginBottom: 6 }}>{title} · {entries.data?.length ?? "…"}</div>
    <p className="t-dim" style={{ margin: "0 0 8px" }}>{hint}</p>
    <form style={{ display: "flex", gap: 8, marginBottom: 8 }} onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
      <input className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label={`Add to ${title}`} />
      <button className="chip" type="submit" disabled={!domain.trim() || add.isPending}>Add</button>
    </form>
    <input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={`Filter ${title}`} />
    <ErrorLine error={entries.error ?? add.error ?? remove.error} />
    <div style={{ height: 270, overflowY: "auto", marginTop: 6 }}>
      {shown.slice(0, 200).map((entry) => <div key={entry.id} className="grid-row" style={{ "--grid-cols": "minmax(0,1fr) 70px" } as React.CSSProperties}>
        <span className="t-body truncate">{entry.domain}</span>
        <button className="btn-quiet" disabled={remove.isPending} onClick={() => remove.mutate(entry.id)} aria-label={`Remove ${entry.domain}`}>Remove</button>
      </div>)}
      {shown.length > 200 ? <p className="t-dim">{shown.length - 200} more; filter to find one.</p> : null}
    </div>
  </div>;
}

function ProposalsPanel({ proposals }: { proposals: readonly MailServerProposal[] }) {
  const pending = proposals.filter(({ status }) => status === "pending");
  const decided = proposals.filter(({ status }) => status !== "pending");
  return <section>
    <p className="t-body" style={{ marginTop: 0 }}>Agents can prepare mail server changes; nothing happens until you approve them here.</p>
    {pending.length === 0 ? <p className="t-dim">No proposals waiting.</p> : null}
    {pending.map((proposal) => <PendingProposal key={proposal.id} proposal={proposal} />)}
    {decided.length ? <>
      <div className="t-sec" style={{ margin: "22px 0 6px" }}>History</div>
      {decided.slice(0, 30).map((proposal) => <div key={proposal.id} style={{ padding: "8px 0", borderTop: "1px solid var(--div)" }}>
        <span className="t-ink">{proposal.title}</span> <span className="t-dim">· {proposal.status} · {proposal.createdBy} · {formatDate(proposal.decidedAt)}</span>
        {proposal.results.map((result) => <div key={result.index} className="t-body" style={{ paddingLeft: 12 }}>{result.ok ? "✓" : "✗"} {result.message}</div>)}
      </div>)}
    </> : null}
  </section>;
}

function PendingProposal({ proposal }: { proposal: MailServerProposal }) {
  const client = useQueryClient();
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const needed = requiredConfirmations(proposal.operations);
  const done = () => client.invalidateQueries({ queryKey: ["mail-server-proposals"] }).then(() => client.invalidateQueries({ queryKey: ["mail-servers"] }));
  const approve = useMutation({
    mutationFn: () => api.approve(proposal.id, { passwords, confirmations: needed.map((name) => (confirmations[name] ?? "").trim().toLowerCase()) }),
    onSuccess: done,
  });
  const reject = useMutation({ mutationFn: () => api.reject(proposal.id), onSuccess: done });
  return <form style={{ padding: "14px 0", borderTop: "1px solid var(--div)", maxWidth: 820 }} onSubmit={(event) => { event.preventDefault(); approve.mutate(); }}>
    <div style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{proposal.title}</span>
      <span className="t-dim">from {proposal.createdBy} · {formatDate(proposal.createdAt)}</span>
    </div>
    <ol className="t-body" style={{ margin: "8px 0", paddingLeft: 20 }}>
      {proposal.operations.map((operation, index) => <li key={index} style={{ marginBottom: 6 }}>
        {describeOperation(operation)}
        {operation.type === "createMailbox" ? <input className="input" type="password" autoComplete="new-password" placeholder={`Password for ${operation.address}`}
          aria-label={`Password for ${operation.address}`} style={{ maxWidth: 320, display: "block", marginTop: 4 }}
          value={passwords[String(index)] ?? ""} onChange={(e) => setPasswords({ ...passwords, [String(index)]: e.target.value })} /> : null}
      </li>)}
    </ol>
    {needed.map((name) => <label key={name} className="field" style={{ maxWidth: 420, marginBottom: 8 }}>
      <span className="field-label">Type {name} to confirm its deletion</span>
      <input className="input" value={confirmations[name] ?? ""} onChange={(e) => setConfirmations({ ...confirmations, [name]: e.target.value })} aria-label={`Type ${name} to confirm`} />
    </label>)}
    <div style={{ display: "flex", gap: 14 }}>
      <button className="btn" type="submit" disabled={approve.isPending || needed.some((name) => (confirmations[name] ?? "").trim().toLowerCase() !== name)}>
        {approve.isPending ? "Applying…" : "Approve and apply"}</button>
      <button className="btn-quiet" type="button" disabled={reject.isPending} onClick={() => reject.mutate()}>Reject</button>
    </div>
    <ErrorLine error={approve.error ?? reject.error} />
  </form>;
}
