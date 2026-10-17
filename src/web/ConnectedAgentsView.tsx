import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentTiers, type AgentTier, type CreatedPersonalToken } from "../shared/agent-access";
import type { Account } from "../shared/contracts";
import { api } from "./api";
import { formatRelative } from "./format";

const tiers = Object.keys(agentTiers) as AgentTier[];

export function ConnectedAgentsView({ accounts }: { accounts: readonly Account[] }) {
  const client = useQueryClient();
  const agents = useQuery({ queryKey: ["connected-agents"], queryFn: ({ signal }) => api.connectedAgents(signal), refetchInterval: 15_000 });
  const [name, setName] = useState("");
  const [tier, setTier] = useState<AgentTier>("propose");
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [created, setCreated] = useState<CreatedPersonalToken | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["connected-agents"] });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeAgent(id), onSuccess: refresh });
  const create = useMutation({
    mutationFn: () => api.createPersonalToken({ name: name.trim(), tier, accountIds: chosen ? [...chosen] : null }),
    onSuccess: (result) => { setCreated(result); setName(""); void refresh(); },
  });
  const endpoint = `${window.location.origin}/mcp`;
  const accountLabel = (ids: readonly string[] | null) => ids === null ? "All accounts"
    : ids.map((id) => accounts.find((account) => account.id === id)?.email ?? "removed account").join(", ");

  return <>
    <div className="toolbar">
      <span className="scope-title">Connected agents</span>
      <span className="t-dim">{agents.data ? `${agents.data.length} connected` : ""}</span>
    </div>
    <div className="readscroll"><div className="pad" style={{ maxWidth: 820 }}>
      <p className="t-body" style={{ margin: "0 0 10px" }}>
        Agents outside this page — Claude, ChatGPT, a CLI — reach your mail through the MCP endpoint below after you approve
        them. No agent can send mail or accept a proposal; every call they make appears in Activity under their name.
      </p>
      <p className="t-body" style={{ margin: "0 0 18px" }}>
        MCP URL <code style={{ userSelect: "all" }}>{endpoint}</code>
      </p>

      <div className="t-sec" style={{ marginBottom: 6 }}>Agents</div>
      {agents.isPending ? <p className="t-dim" role="status">Loading agents…</p> : null}
      {agents.error ? <p className="alert error" role="alert">{agents.error.message} <button className="btn-underline" onClick={() => void agents.refetch()}>Try again</button></p> : null}
      {revoke.error ? <p className="alert error" role="alert">{revoke.error.message}</p> : null}
      {agents.data?.length === 0 ? <p className="t-dim">No agent is connected.</p> : null}
      {agents.data?.map((agent) => (
        <div className="grid-row" key={agent.id} style={{ "--grid-cols": "minmax(140px,1fr) 60px 150px minmax(120px,1fr) 110px 70px", height: "auto", padding: "6px 0" } as React.CSSProperties}>
          <span className="t-ink truncate" title={agent.redirectHost ?? undefined}>
            {agent.name}{agent.redirectHost ? <span className="t-dim"> · {agent.redirectHost}</span> : null}
          </span>
          <span className="t-dim">{agent.kind === "oauth" ? "OAuth" : "Token"}</span>
          <span className="t-body">{agentTiers[agent.tier].label}</span>
          <span className="t-dim truncate">{accountLabel(agent.accountIds)}</span>
          <span className="t-dim t-num">{agent.lastUsedAt ? `used ${formatRelative(agent.lastUsedAt)}` : "never used"}</span>
          <span style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="btn-danger" disabled={revoke.isPending} aria-label={`Revoke ${agent.name}`}
              onClick={() => revoke.mutate(agent.id)}>Revoke</button>
          </span>
        </div>
      ))}

      <div className="t-sec" style={{ margin: "26px 0 8px" }}>Personal access token</div>
      <p className="t-body" style={{ margin: "0 0 10px" }}>
        For CLI agents that cannot open a browser. The token is shown once and does not expire; revoke it here.
      </p>
      <form onSubmit={(event) => { event.preventDefault(); create.mutate(); }} style={{ display: "grid", gap: 10, maxWidth: 520 }}>
        <label className="field"><span className="field-label">Name</span>
          <input className="input" aria-label="Token name" value={name} maxLength={100} placeholder="laptop" onChange={(event) => setName(event.target.value)} /></label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {tiers.map((option) => (
            <button type="button" key={option} className={`opt opt-accent ${tier === option ? "on" : ""}`} aria-pressed={tier === option}
              style={{ padding: "4px 10px", background: tier === option ? undefined : "var(--field)" }}
              onClick={() => setTier(option)}>{agentTiers[option].label}</button>
          ))}
        </div>
        <div>
          <label className="t-body" style={{ display: "block" }}>
            <input type="checkbox" checked={chosen === null} onChange={(event) => setChosen(event.target.checked ? null : new Set(accounts.map(({ id }) => id)))} />
            {" "}All accounts, including ones added later
          </label>
          {chosen !== null ? accounts.map((account) => (
            <label key={account.id} className="t-body" style={{ display: "block", paddingLeft: 20 }}>
              <input type="checkbox" checked={chosen.has(account.id)} onChange={(event) => {
                const next = new Set(chosen);
                if (event.target.checked) next.add(account.id); else next.delete(account.id);
                setChosen(next);
              }} />{" "}{account.email}
            </label>
          )) : null}
        </div>
        <div><button className="btn" type="submit" disabled={!name.trim() || create.isPending || chosen?.size === 0}>Create token</button></div>
      </form>
      {create.error ? <p className="alert error" role="alert" style={{ marginTop: 10 }}>{create.error.message}</p> : null}
      {created ? <div role="status" className="alert" style={{ marginTop: 12 }}>
        <p className="t-body" style={{ margin: "0 0 6px" }}>Copy the token for {created.agent.name} now; it is not shown again.</p>
        <code style={{ userSelect: "all", wordBreak: "break-all" }}>{created.token}</code>
        <p className="t-dim" style={{ margin: "8px 0 0" }}>
          Claude Code: <code>claude mcp add --transport http postreeve {endpoint} --header "Authorization: Bearer {created.token}"</code>
        </p>
      </div> : null}
    </div></div>
  </>;
}
