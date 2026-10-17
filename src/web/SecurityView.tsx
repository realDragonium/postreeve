import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { authApi, passkeyErrorMessage, type SessionSummary } from "./auth-api";
import { defaultPasskeyName, useOwner } from "./AuthGate";
import { formatDate } from "./format";

const passkeysKey = ["auth-passkeys"] as const;
const sessionsKey = ["auth-sessions"] as const;

/** Settings → Security: passkeys, password, sessions and sign-out for the single owner. */
export function SecurityView() {
  const owner = useOwner();
  return <div className="readscroll"><div className="pad" style={{ maxWidth: 760 }}>
    <Passkeys available={owner.passkeys} />
    <div className="strong" style={{ margin: "24px 0 0" }} />
    <PasswordChange />
    <div className="strong" style={{ margin: "24px 0 0" }} />
    <Sessions />
    <div className="strong" style={{ margin: "24px 0 0" }} />
    <div style={{ paddingTop: 18 }}>
      <button className="chip" onClick={() => void owner.signOut()}>Sign out</button>
    </div>
  </div></div>;
}

function Passkeys({ available }: { available: boolean }) {
  const queryClient = useQueryClient();
  const passkeys = useQuery({ queryKey: passkeysKey, queryFn: authApi.passkeys });
  const [name, setName] = useState(defaultPasskeyName());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => authApi.addPasskey(name.trim()),
    onSuccess: () => { setName(defaultPasskeyName()); void queryClient.invalidateQueries({ queryKey: passkeysKey }); },
  });
  const remove = useMutation({
    mutationFn: authApi.removePasskey,
    onSuccess: () => { setConfirmingId(null); void queryClient.invalidateQueries({ queryKey: passkeysKey }); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); add.mutate(); };
  const list = passkeys.data ?? [];

  return <section aria-label="Passkeys">
    <div className="t-sec" style={{ marginBottom: 10 }}>Passkeys</div>
    <p className="t-body" style={{ margin: "0 0 12px" }}>
      Passkeys are the primary way to sign in. Each is tied to this Postreeve address; remove one if its device is lost.
    </p>
    {passkeys.isError ? <div className="alert error">Could not load passkeys: {passkeys.error.message}</div> : null}
    {list.length === 0 && passkeys.isSuccess ? <p className="t-dim">No passkeys yet. You sign in with your password.</p> : null}
    {list.map((passkey) => <div key={passkey.id} className="grid-row" style={{ "--grid-cols": "minmax(0,1fr) 150px 150px 120px" } as React.CSSProperties}>
      <span className="t-ink truncate">{passkey.name}{passkey.backedUp ? <span className="t-dim"> · synced</span> : null}</span>
      <span className="t-dim">Added {formatDate(passkey.createdAt)}</span>
      <span className="t-dim">{passkey.lastUsedAt ? `Used ${formatDate(passkey.lastUsedAt)}` : "Never used"}</span>
      {confirmingId === passkey.id
        ? <span style={{ display: "flex", gap: 10 }}>
          <button className="btn-danger" disabled={remove.isPending} onClick={() => remove.mutate(passkey.id)} aria-label={`Confirm removing ${passkey.name}`}>Remove</button>
          <button className="btn-quiet" onClick={() => setConfirmingId(null)}>Keep</button>
        </span>
        : <button className="btn-quiet" onClick={() => setConfirmingId(passkey.id)} aria-label={`Remove ${passkey.name}`}>Remove</button>}
    </div>)}
    {remove.isError ? <div className="alert error">{remove.error.message}</div> : null}
    {available
      ? <form onSubmit={submit} style={{ display: "flex", alignItems: "flex-end", gap: 10, marginTop: 14 }}>
        <label className="field" style={{ flex: 1, maxWidth: 320 }}><span className="field-label">New passkey name</span>
          <input className="input" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="btn" disabled={add.isPending || !name.trim()}>Add passkey</button>
      </form>
      : <p className="t-dim" style={{ marginTop: 12 }}>
        Passkeys need a domain name over a secure connection. Open Postreeve at http://localhost or at its public https
        address to add one.
      </p>}
    {add.isError ? <div className="alert error" role="alert" style={{ marginTop: 10 }}>{passkeyErrorMessage(add.error)}</div> : null}
  </section>;
}

function PasswordChange() {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const change = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: () => {
      setCurrent(""); setNext(""); setRepeat("");
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });
  const valid = current.length > 0 && next.length >= 12 && next === repeat;

  return <section aria-label="Password" style={{ paddingTop: 18 }}>
    <div className="t-sec" style={{ marginBottom: 10 }}>Password</div>
    <p className="t-body" style={{ margin: "0 0 12px" }}>
      The password is the fallback when no passkey is at hand. Changing it signs out every other session.
    </p>
    <form onSubmit={(event) => { event.preventDefault(); change.mutate(); }} style={{ display: "grid", gap: 10, maxWidth: 320 }}>
      <label className="field"><span className="field-label">Current password</span>
        <input className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
      </label>
      <label className="field"><span className="field-label">New password</span>
        <input className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
      </label>
      <label className="field"><span className="field-label">Repeat new password</span>
        <input className="input" type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
      </label>
      {repeat && next !== repeat ? <div className="alert error">The new passwords do not match.</div> : null}
      {change.isError ? <div className="alert error" role="alert">{change.error.message}</div> : null}
      {change.isSuccess ? <div className="alert" role="status">Password changed. Other sessions were signed out.</div> : null}
      <span><button className="btn" disabled={change.isPending || !valid}>Change password</button></span>
    </form>
  </section>;
}

function Sessions() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: authApi.sessions });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: sessionsKey });
  const revoke = useMutation({ mutationFn: authApi.revokeSession, onSuccess: refresh });
  const revokeOthers = useMutation({ mutationFn: authApi.revokeOtherSessions, onSuccess: refresh });
  const list = sessions.data ?? [];
  const others = list.filter((session) => !session.current).length;

  return <section aria-label="Sessions" style={{ paddingTop: 18 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
      <span className="t-sec">Sessions</span>
      <button className="btn-quiet" style={{ marginLeft: "auto" }} disabled={revokeOthers.isPending || others === 0} onClick={() => revokeOthers.mutate()}>
        Sign out other sessions
      </button>
    </div>
    <p className="t-body" style={{ margin: "0 0 12px" }}>
      A session ends after 7 days without use, and 30 days after sign-in at the latest.
    </p>
    {sessions.isError ? <div className="alert error">Could not load sessions: {sessions.error.message}</div> : null}
    {list.map((session) => <div key={session.id} className="grid-row" style={{ "--grid-cols": "minmax(0,1fr) 150px 90px" } as React.CSSProperties}>
      <span className="t-ink truncate" title={session.userAgent}>
        {describeAgent(session)}{session.current ? <span className="t-dim"> · this browser</span> : null}
      </span>
      <span className="t-dim">Active {formatDate(session.lastSeenAt)}</span>
      {session.current ? <span /> : <button className="btn-quiet" disabled={revoke.isPending} onClick={() => revoke.mutate(session.id)}>Sign out</button>}
    </div>)}
    {revokeOthers.isSuccess ? <div className="alert" role="status" style={{ marginTop: 10 }}>Signed out {revokeOthers.data.revoked} other session{revokeOthers.data.revoked === 1 ? "" : "s"}.</div> : null}
  </section>;
}

function describeAgent(session: SessionSummary): string {
  const agent = session.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome"
    : /Safari\//.test(agent) ? "Safari" : "Browser";
  const platform = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS"
    : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  const via = session.method === "passkey" ? "passkey" : "password";
  return `${browser}${platform ? ` on ${platform}` : ""} · ${via}`;
}
