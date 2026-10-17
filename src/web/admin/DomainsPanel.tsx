import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MailDomain, MailServerSummary, Mailbox, MailingList, DkimAlgorithm } from "../../shared/mail-server";
import { Sheet } from "../panels";
import { mailServerApi as api } from "./api";
import { ConfirmSheet, ErrorLine, copy } from "./common";
import { DnsPlanPanel } from "./DnsProviders";
import {
  categoryLabels, dnsStatusLabels, formatBytes, formatDate, parseAddressList, parseQuotaGib, quotaToGib, sortChecks,
} from "./format";

const sections = ["Mailboxes", "Mailing lists", "DKIM", "DNS"] as const;
type Section = (typeof sections)[number];

export function DomainsPanel({ server }: { server: MailServerSummary }) {
  const client = useQueryClient();
  const domains = useQuery({ queryKey: ["mail-server-domains", server.id], queryFn: () => api.domains(server.id) });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.addDomain(server.id, name),
    onSuccess: async (domain) => {
      setName(""); setSelectedId(domain.id);
      await client.invalidateQueries({ queryKey: ["mail-server-domains", server.id] });
      await client.invalidateQueries({ queryKey: ["mail-servers"] });
    },
  });
  const list = domains.data ?? [];
  const selected = list.find(({ id }) => id === selectedId) ?? list[0] ?? null;
  return <div style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: 24 }}>
    <div>
      <div className="t-sec" style={{ marginBottom: 6 }}>Domains</div>
      <ErrorLine error={domains.error} />
      {list.map((domain) => <button key={domain.id} className="opt" style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 2 }}
        aria-pressed={domain.id === selected?.id} onClick={() => setSelectedId(domain.id)}>{domain.name}{domain.enabled ? "" : " (off)"}</button>)}
      <form style={{ display: "flex", gap: 6, marginTop: 10 }} onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
        <input className="input" placeholder="example.org" value={name} onChange={(e) => setName(e.target.value)} aria-label="New domain" />
        <button className="chip" type="submit" disabled={!name.trim() || add.isPending}>Add</button>
      </form>
      <ErrorLine error={add.error} />
    </div>
    {selected ? <DomainDetail key={selected.id} server={server} domain={selected} onDeleted={() => setSelectedId(null)} /> : <p className="t-dim">Add a domain to start.</p>}
  </div>;
}

function DomainDetail({ server, domain, onDeleted }: { server: MailServerSummary; domain: MailDomain; onDeleted: () => void }) {
  const client = useQueryClient();
  const [section, setSection] = useState<Section>("Mailboxes");
  const [deleting, setDeleting] = useState(false);
  const [catchAll, setCatchAll] = useState(domain.catchAll ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const refreshDomains = () => client.invalidateQueries({ queryKey: ["mail-server-domains", server.id] });
  const saveCatchAll = useMutation({
    mutationFn: () => api.setCatchAll(server.id, domain.id, catchAll.trim() || null),
    onSuccess: async (result) => {
      setNotice(result.identity ? identityNotice(result.identity) : null);
      await refreshDomains();
    },
  });
  const remove = useMutation({
    mutationFn: (confirm: string) => api.deleteDomain(server.id, domain.id, confirm),
    onSuccess: async () => { setDeleting(false); onDeleted(); await refreshDomains(); await client.invalidateQueries({ queryKey: ["mail-servers"] }); },
  });
  return <div style={{ minWidth: 0 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{domain.name}</span>
      <span className="t-dim">DKIM {domain.dkimManagement}{domain.aliases.length ? ` · aliases ${domain.aliases.join(", ")}` : ""}</span>
      <button className="btn-danger" style={{ marginLeft: "auto" }} onClick={() => setDeleting(true)}>Delete domain</button>
    </div>
    <form style={{ display: "flex", gap: 8, alignItems: "end", margin: "12px 0", maxWidth: 560 }} onSubmit={(event) => { event.preventDefault(); saveCatchAll.mutate(); }}>
      <label className="field" style={{ flex: 1 }}><span className="field-label">Catch-all: deliver unknown addresses to</span>
        <input className="input" placeholder="Off" value={catchAll} onChange={(e) => setCatchAll(e.target.value)} /></label>
      <button className="chip" type="submit" disabled={saveCatchAll.isPending || catchAll.trim() === (domain.catchAll ?? "")}>Save</button>
    </form>
    <ErrorLine error={saveCatchAll.error} />
    {notice ? <p className="t-dim" role="status">{notice}</p> : null}
    <div className="tabs" style={{ margin: "8px 0 12px" }}>
      {sections.map((name) => <button key={name} className="opt" aria-pressed={section === name} onClick={() => setSection(name)}>{name}</button>)}
    </div>
    {section === "Mailboxes" ? <MailboxesSection server={server} domain={domain} /> : null}
    {section === "Mailing lists" ? <ListsSection serverId={server.id} domain={domain} /> : null}
    {section === "DKIM" ? <DkimSection serverId={server.id} domain={domain} /> : null}
    {section === "DNS" ? <DnsSection serverId={server.id} domain={domain} /> : null}
    {deleting ? <ConfirmSheet title={`Delete ${domain.name}`} typed={domain.name} action="Delete domain" pending={remove.isPending} error={remove.error}
      body={<>Stalwart stops accepting mail for {domain.name} and its DKIM keys are deleted. Delete its mailboxes and mailing lists first; Postreeve never deletes them for you.</>}
      onConfirm={(value) => remove.mutate(value)} onClose={() => setDeleting(false)} /> : null}
  </div>;
}

function identityNotice(identity: { address: string; status: string; reason: string | null }): string {
  if (identity.status === "registered") return `Postreeve can now send as ${identity.address}.`;
  if (identity.status === "existing") return `Postreeve already sends as ${identity.address}.`;
  return `Identity ${identity.address} not added: ${identity.reason ?? "unknown reason"}.`;
}

function MailboxesSection({ server, domain }: { server: MailServerSummary; domain: MailDomain }) {
  const mailboxes = useQuery({ queryKey: ["mail-server-mailboxes", server.id, domain.id], queryFn: () => api.mailboxes(server.id, domain.id) });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  return <section>
    <div style={{ display: "flex", marginBottom: 8 }}><button className="chip" onClick={() => setCreating(true)}>New mailbox</button></div>
    <ErrorLine error={mailboxes.error} />
    {mailboxes.data?.length === 0 ? <p className="t-dim">No mailboxes on {domain.name} yet.</p> : null}
    {mailboxes.data?.length ? <div style={{ "--grid-cols": "minmax(0,1.3fr) minmax(0,1fr) 150px 110px 60px" } as React.CSSProperties}>
      <div className="grid-head"><span className="t-sec">Address</span><span className="t-sec">Aliases</span><span className="t-sec">Storage</span><span className="t-sec">Postreeve</span><span /></div>
      {mailboxes.data.map((mailbox) => <div className="grid-row" key={mailbox.id}>
        <span className="truncate"><span className="t-ink">{mailbox.address}</span>{mailbox.displayName ? <span className="t-dim"> · {mailbox.displayName}</span> : null}</span>
        <span className="t-body truncate">{mailbox.aliases.map(({ address }) => address).join(", ") || "—"}</span>
        <span className="t-dim">{formatBytes(mailbox.usedBytes)} of {formatBytes(mailbox.quotaBytes)}</span>
        <span className="t-body">{mailbox.postreeveAccountId ? "connected" : "—"}</span>
        <button className="btn-quiet" onClick={() => setEditing(mailbox)}>Manage</button>
      </div>)}
    </div> : null}
    {creating ? <CreateMailboxSheet server={server} domain={domain} onClose={() => setCreating(false)} /> : null}
    {editing ? <MailboxSheet serverId={server.id} mailbox={mailboxes.data?.find(({ id }) => id === editing.id) ?? editing} domain={domain} onClose={() => setEditing(null)} /> : null}
  </section>;
}

function useRefreshMailboxes(serverId: string, domainId: string) {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: ["mail-server-mailboxes", serverId, domainId] });
    await client.invalidateQueries({ queryKey: ["accounts"] });
  };
}

function CreateMailboxSheet({ server, domain, onClose }: { server: MailServerSummary; domain: MailDomain; onClose: () => void }) {
  const refresh = useRefreshMailboxes(server.id, domain.id);
  const [localPart, setLocalPart] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [quota, setQuota] = useState("");
  const [addToPostreeve, setAddToPostreeve] = useState(true);
  const quotaBytes = parseQuotaGib(quota);
  const create = useMutation({
    mutationFn: () => api.createMailbox(server.id, { domainId: domain.id, localPart, displayName, password, quotaBytes: quotaBytes ?? null, addToPostreeve }),
    onSuccess: refresh,
  });
  if (create.data) {
    const { mailbox, account } = create.data;
    return <Sheet title="Mailbox created" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <p className="t-body">{mailbox.address} exists on {server.name}.</p>
      {account.status === "added" ? <p className="t-body">It is also a Postreeve account now. Postreeve signs in with its own app password named Postreeve; revoke it in Stalwart to cut Postreeve off.</p> : null}
      {account.status === "failed" ? <p className="alert error" role="alert">Not added to Postreeve: {account.reason}. The unused app password was revoked; try "Add to Postreeve" on the mailbox once DNS and TLS for {server.mailHostname} work.</p> : null}
    </Sheet>;
  }
  return <Sheet title={`New mailbox on ${domain.name}`} onClose={onClose} closeDisabled={create.isPending}
    onSubmit={(event) => { event.preventDefault(); if (quotaBytes !== undefined) create.mutate(); }}
    footer={<><button type="submit" className="btn" disabled={create.isPending || quotaBytes === undefined}>{create.isPending ? "Creating…" : "Create mailbox"}</button>
      <button type="button" className="btn-quiet push" onClick={onClose}>Cancel</button></>}>
    <div className="field-grid">
      <label className="field"><span className="field-label">Address</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><input className="input" value={localPart} onChange={(e) => setLocalPart(e.target.value)} required aria-label="Local part" /><span className="t-dim">@{domain.name}</span></span></label>
      <label className="field"><span className="field-label">Display name</span><input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label className="field"><span className="field-label">Password (at least 8 characters)</span><input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
      <label className="field"><span className="field-label">Quota in GiB (blank = unlimited)</span><input className="input t-num" value={quota} onChange={(e) => setQuota(e.target.value)} /></label>
    </div>
    <label className="check"><input type="checkbox" checked={addToPostreeve} onChange={(e) => setAddToPostreeve(e.target.checked)} /> Also add it to Postreeve (uses an app password, never this password)</label>
    <p className="t-dim" style={{ margin: 0 }}>Postreeve sends the password to Stalwart once and does not keep it. Postreeve connects to {server.mailHostname} on IMAP 993 and SMTP 465.</p>
    <ErrorLine error={create.error} />
  </Sheet>;
}

function MailboxSheet({ serverId, mailbox, domain, onClose }: { serverId: string; mailbox: Mailbox; domain: MailDomain; onClose: () => void }) {
  const refresh = useRefreshMailboxes(serverId, domain.id);
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [quota, setQuota] = useState(quotaToGib(mailbox.quotaBytes));
  const [alias, setAlias] = useState("");
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const quotaBytes = parseQuotaGib(quota);
  const save = useMutation({ mutationFn: () => api.updateMailbox(serverId, mailbox.id, { displayName, quotaBytes: quotaBytes ?? null }), onSuccess: async () => { setNotice("Saved."); await refresh(); } });
  const addAlias = useMutation({
    mutationFn: () => api.addAlias(serverId, mailbox.id, alias.includes("@") ? alias : `${alias}@${domain.name}`),
    onSuccess: async (result) => { setAlias(""); setNotice(result.identity ? identityNotice(result.identity) : "Alias added."); await refresh(); },
  });
  const removeAlias = useMutation({ mutationFn: (address: string) => api.removeAlias(serverId, mailbox.id, address), onSuccess: refresh });
  const reset = useMutation({ mutationFn: () => api.resetPassword(serverId, mailbox.id, password), onSuccess: () => { setPassword(""); setNotice("Password changed. App passwords, including Postreeve's, keep working."); } });
  const connect = useMutation({
    mutationFn: () => api.addToPostreeve(serverId, mailbox.id),
    onSuccess: async (result) => { setNotice(result.account.status === "added" ? "Added to Postreeve." : `Not added: ${result.account.reason}`); await refresh(); },
  });
  const remove = useMutation({ mutationFn: (confirm: string) => api.deleteMailbox(serverId, mailbox.id, confirm), onSuccess: async () => { await refresh(); onClose(); } });
  return <Sheet title={mailbox.address} meta={`${formatBytes(mailbox.usedBytes)} used`} onClose={onClose}
    footer={<><button className="btn-danger" onClick={() => setDeleting(true)}>Delete mailbox</button><button className="btn-quiet push" onClick={onClose}>Close</button></>}>
    <form style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 160px auto", gap: 12, alignItems: "end" }} onSubmit={(event) => { event.preventDefault(); if (quotaBytes !== undefined) save.mutate(); }}>
      <label className="field"><span className="field-label">Display name</span><input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
      <label className="field"><span className="field-label">Quota GiB (blank = unlimited)</span><input className="input t-num" value={quota} onChange={(e) => setQuota(e.target.value)} /></label>
      <button className="chip" type="submit" disabled={save.isPending || quotaBytes === undefined}>Save</button>
    </form>
    <fieldset><legend>Aliases</legend>
      {mailbox.aliases.length === 0 ? <p className="t-dim" style={{ margin: "0 0 8px" }}>No aliases.</p> : null}
      {mailbox.aliases.map(({ address }) => <div key={address} className="grid-row" style={{ "--grid-cols": "minmax(0,1fr) 70px" } as React.CSSProperties}>
        <span className="t-body">{address}</span>
        <button className="btn-quiet" disabled={removeAlias.isPending} onClick={() => removeAlias.mutate(address)}>Remove</button>
      </div>)}
      <form style={{ display: "flex", gap: 8, marginTop: 8 }} onSubmit={(event) => { event.preventDefault(); addAlias.mutate(); }}>
        <input className="input" placeholder={`info or info@${domain.name}`} value={alias} onChange={(e) => setAlias(e.target.value)} aria-label="New alias" />
        <button className="chip" type="submit" disabled={!alias.trim() || addAlias.isPending}>Add alias</button>
      </form>
    </fieldset>
    <form style={{ display: "flex", gap: 8, alignItems: "end" }} onSubmit={(event) => { event.preventDefault(); reset.mutate(); }}>
      <label className="field" style={{ flex: 1 }}><span className="field-label">New password</span>
        <input className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="chip" type="submit" disabled={password.length < 8 || reset.isPending}>Reset password</button>
    </form>
    {mailbox.postreeveAccountId ? <p className="t-dim" style={{ margin: 0 }}>This mailbox is a Postreeve account.</p>
      : <div><button className="chip" disabled={connect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? "Connecting…" : "Add to Postreeve"}</button></div>}
    {notice ? <p className="t-dim" role="status" style={{ margin: 0 }}>{notice}</p> : null}
    <ErrorLine error={save.error ?? addAlias.error ?? removeAlias.error ?? reset.error ?? connect.error} />
    {deleting ? <ConfirmSheet title={`Delete ${mailbox.address}`} typed={mailbox.address} action="Delete mailbox and its mail" pending={remove.isPending} error={remove.error}
      body={<>Stalwart deletes this mailbox and all of its mail. This cannot be undone.{mailbox.postreeveAccountId ? " The Postreeve account for it stays but will stop working; remove it under Accounts." : ""}</>}
      onConfirm={(value) => remove.mutate(value)} onClose={() => setDeleting(false)} /> : null}
  </Sheet>;
}

function ListsSection({ serverId, domain }: { serverId: string; domain: MailDomain }) {
  const client = useQueryClient();
  const lists = useQuery({ queryKey: ["mail-server-lists", serverId, domain.id], queryFn: () => api.lists(serverId, domain.id) });
  const refresh = () => client.invalidateQueries({ queryKey: ["mail-server-lists", serverId, domain.id] });
  const [localPart, setLocalPart] = useState("");
  const [recipients, setRecipients] = useState("");
  const [deleting, setDeleting] = useState<MailingList | null>(null);
  const parsed = parseAddressList(recipients);
  const create = useMutation({ mutationFn: () => api.createList(serverId, { domainId: domain.id, localPart, recipients: parsed ?? [] }), onSuccess: async () => { setLocalPart(""); setRecipients(""); await refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteList(serverId, id), onSuccess: async () => { setDeleting(null); await refresh(); } });
  return <section>
    <ErrorLine error={lists.error} />
    {lists.data?.map((list) => <ListRow key={list.id} serverId={serverId} list={list} onDelete={() => setDeleting(list)} onSaved={refresh} />)}
    <form style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr) auto", gap: 8, alignItems: "end", marginTop: 12 }} onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <label className="field"><span className="field-label">New list</span><span style={{ display: "flex", alignItems: "center", gap: 4 }}><input className="input" value={localPart} onChange={(e) => setLocalPart(e.target.value)} aria-label="List local part" /><span className="t-dim">@{domain.name}</span></span></label>
      <label className="field"><span className="field-label">Recipients</span><input className="input" placeholder="alice@example.org, bob@example.org" value={recipients} onChange={(e) => setRecipients(e.target.value)} /></label>
      <button className="chip" type="submit" disabled={!localPart.trim() || parsed === null || create.isPending}>Create list</button>
    </form>
    <ErrorLine error={create.error} />
    {deleting ? <ConfirmSheet title={`Delete ${deleting.address}`} action="Delete list" pending={remove.isPending} error={remove.error}
      body="Mail to this address will bounce. The recipients' own mailboxes are not affected." onConfirm={() => remove.mutate(deleting.id)} onClose={() => setDeleting(null)} /> : null}
  </section>;
}

function ListRow({ serverId, list, onDelete, onSaved }: { serverId: string; list: MailingList; onDelete: () => void; onSaved: () => void }) {
  const [recipients, setRecipients] = useState(list.recipients.join(", "));
  const parsed = parseAddressList(recipients);
  const save = useMutation({ mutationFn: () => api.updateList(serverId, list.id, { recipients: parsed ?? [] }), onSuccess: onSaved });
  return <form style={{ padding: "8px 0", borderTop: "1px solid var(--div)" }} onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
      <span className="t-ink">{list.address}</span><span className="t-dim">{list.recipients.length} recipient{list.recipients.length === 1 ? "" : "s"}</span>
      <button type="button" className="btn-danger" style={{ marginLeft: "auto" }} onClick={onDelete}>Delete</button>
    </div>
    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
      <input className="input" value={recipients} onChange={(e) => setRecipients(e.target.value)} aria-label={`Recipients of ${list.address}`} />
      <button className="chip" type="submit" disabled={parsed === null || save.isPending || recipients === list.recipients.join(", ")}>Save</button>
    </div>
    <ErrorLine error={save.error} />
  </form>;
}

function DkimSection({ serverId, domain }: { serverId: string; domain: MailDomain }) {
  const client = useQueryClient();
  const keys = useQuery({ queryKey: ["mail-server-dkim", serverId, domain.id], queryFn: () => api.dkim(serverId, domain.id) });
  const refresh = () => client.invalidateQueries({ queryKey: ["mail-server-dkim", serverId, domain.id] });
  const [algorithm, setAlgorithm] = useState<DkimAlgorithm>("rsa");
  const [selector, setSelector] = useState(`pr${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`);
  const [deleting, setDeleting] = useState<string | null>(null);
  const generate = useMutation({ mutationFn: () => api.generateDkim(serverId, domain.id, algorithm, selector), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteDkim(serverId, id), onSuccess: async () => { setDeleting(null); await refresh(); } });
  return <section>
    <p className="t-body" style={{ marginTop: 0 }}>{domain.dkimManagement === "automatic"
      ? "Stalwart generates and rotates this domain's keys automatically. Add a key here only for an extra selector or algorithm."
      : "This domain's keys are managed by hand."} Publish each key's TXT record from the DNS tab before mail is signed with it.</p>
    <ErrorLine error={keys.error} />
    {keys.data?.map((key) => <div key={key.id} className="grid-row" style={{ "--grid-cols": "160px 150px 80px minmax(0,1fr) 60px" } as React.CSSProperties}>
      <span className="t-ink">{key.selector}</span>
      <span className="t-body">{key.algorithm.replace("Dkim1", "").replace("Sha256", "")}</span>
      <span className="t-dim">{key.stage}</span>
      <span className="t-dim truncate" title={key.publicKey}>{formatDate(key.createdAt)}</span>
      <button className="btn-danger" onClick={() => setDeleting(key.id)}>Delete</button>
    </div>)}
    <form style={{ display: "flex", gap: 8, alignItems: "end", marginTop: 12 }} onSubmit={(event) => { event.preventDefault(); generate.mutate(); }}>
      <label className="field"><span className="field-label">Algorithm</span>
        <select className="input" value={algorithm} onChange={(e) => setAlgorithm(e.target.value as DkimAlgorithm)}><option value="rsa">RSA-2048</option><option value="ed25519">Ed25519</option></select></label>
      <label className="field"><span className="field-label">Selector</span><input className="input" value={selector} onChange={(e) => setSelector(e.target.value)} /></label>
      <button className="chip" type="submit" disabled={!selector.trim() || generate.isPending}>{generate.isPending ? "Generating…" : "Generate key"}</button>
    </form>
    <ErrorLine error={generate.error} />
    {deleting ? <ConfirmSheet title="Delete DKIM key" action="Delete key" pending={remove.isPending} error={remove.error}
      body="Mail already signed with this key fails DKIM checks once its DNS record is removed. Keep at least one active key."
      onConfirm={() => remove.mutate(deleting)} onClose={() => setDeleting(null)} /> : null}
  </section>;
}

function DnsSection({ serverId, domain }: { serverId: string; domain: MailDomain }) {
  const checklist = useQuery({ queryKey: ["mail-server-dns", serverId, domain.id], queryFn: () => api.dns(serverId, domain.id) });
  const data = checklist.data;
  return <section>
    <DnsPlanPanel serverId={serverId} domainId={domain.id} />
    <div style={{ display: "flex", gap: 16, alignItems: "baseline", marginBottom: 8 }}>
      <span className="t-body">{data ? `${data.records.filter(({ status }) => status === "ok").length} of ${data.records.length} records match · ${data.resolver} · ${formatDate(data.checkedAt)}` : "Checking DNS…"}</span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 16 }}>
        <button className="btn-quiet" disabled={checklist.isFetching} onClick={() => void checklist.refetch()}>Check again</button>
        {data ? <button className="btn-quiet" onClick={() => void copy(data.zone)}>Copy zone file</button> : null}
      </span>
    </div>
    <ErrorLine error={checklist.error} />
    {data ? <div style={{ "--grid-cols": "90px 100px 60px minmax(0,1fr) minmax(0,1.6fr)" } as React.CSSProperties}>
      <div className="grid-head"><span className="t-sec">Status</span><span className="t-sec">Kind</span><span className="t-sec">Type</span><span className="t-sec">Name</span><span className="t-sec">Value</span></div>
      {sortChecks(data.records).map((record, index) => <div key={index} className="grid-row" style={{ height: "auto", alignItems: "start", padding: "6px 0" }}>
        <span className={record.status === "ok" ? "t-body" : "t-ink"} style={{ fontWeight: record.status === "ok" ? 400 : 600 }}>{dnsStatusLabels[record.status]}</span>
        <span className="t-body">{categoryLabels[record.category]}</span>
        <span className="t-dim">{record.type}</span>
        <button className="btn-quiet truncate" style={{ textAlign: "left" }} title="Copy name" onClick={() => void copy(record.name)}>{record.name}</button>
        <span style={{ minWidth: 0 }}>
          <button className="btn-quiet" style={{ textAlign: "left", overflowWrap: "anywhere", whiteSpace: "normal" }} title="Copy value" onClick={() => void copy(record.value)}>{record.value}</button>
          {record.status === "different" ? <span className="t-dim" style={{ display: "block", overflowWrap: "anywhere" }}>Found: {record.found.join(" | ")}</span> : null}
          {record.error ? <span className="t-dim" style={{ display: "block" }}>{record.error}</span> : null}
        </span>
      </div>)}
    </div> : null}
    <p className="t-dim">Click a name or value to copy it. Lower the TTL of MX and SPF records to 300 seconds a day before moving a domain between servers.</p>
  </section>;
}
