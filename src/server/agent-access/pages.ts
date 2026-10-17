import type { Account } from "../../shared/contracts";
import { agentTiers, type AgentTier } from "../../shared/agent-access";

// Server-rendered so consent needs no SPA route and no script: the CSP allows inline styles only.

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

const styles = `
  :root { color-scheme: light dark; --ink: #1d1d1f; --dim: #6e6e73; --line: #d2d2d7; --field: #f5f5f7; --accent: #0a58ca; --page: #fff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --dim: #a1a1a6; --line: #3a3a3c; --field: #1c1c1e; --accent: #5fa8ff; --page: #000; } }
  body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 520px; margin: 48px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 14px; }
  .dim { color: var(--dim); }
  fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 14px; padding: 10px 14px; }
  legend { padding: 0 4px; font-weight: 600; }
  label { display: block; padding: 4px 0; }
  .host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--field); padding: 1px 5px; border-radius: 4px; }
  .actions { display: flex; gap: 8px; margin-top: 18px; }
  button { font: inherit; padding: 7px 16px; border-radius: 6px; border: 1px solid var(--line); background: var(--field); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Postreeve</title><style>${styles}</style></head><body><main>${body}</main></body></html>`;
}

export function noticePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

export function signInPage(): string {
  return page("Sign in to Postreeve", `<h1>Sign in to Postreeve</h1>
<p>An agent is asking to connect to your mail. Only the signed-in owner can allow that.</p>
<p>Open <a href="/">Postreeve</a> in this browser, sign in, then come back to this tab and reload it.</p>`);
}

export interface ConsentPageInput {
  readonly requestId: string;
  readonly clientName: string;
  readonly redirectHost: string;
  readonly tier: AgentTier;
  readonly accounts: readonly Account[];
}

export function consentPage(input: ConsentPageInput): string {
  const tiers = (Object.keys(agentTiers) as AgentTier[]).map((tier) => `<label><input type="radio" name="tier" value="${tier}"${tier === input.tier ? " checked" : ""}>
    ${escapeHtml(agentTiers[tier].label)}${tier === "propose" ? ' <span class="dim">— recommended: it prepares, you accept</span>' : ""}</label>`).join("");
  const accounts = input.accounts.map((account) => `<label><input type="checkbox" name="account" value="${escapeHtml(account.id)}" checked>
    ${escapeHtml(account.email)}</label>`).join("");
  return page("Connect an agent", `<h1>Connect ${escapeHtml(input.clientName)}?</h1>
<p class="dim">The agent named itself <strong>${escapeHtml(input.clientName)}</strong> and will receive access at
<span class="host">${escapeHtml(input.redirectHost)}</span>. Allow only if you started this connection.</p>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
  <fieldset><legend>What it may do</legend>${tiers}
    <p class="dim" style="margin:8px 0 0">Act means moving, flagging, trashing and undoing mail, and changing folders; every action is audited and undoable.
    No agent can send mail or accept a proposal: those stay with you in Postreeve.</p></fieldset>
  <fieldset><legend>Which accounts</legend>
    <label><input type="radio" name="scope_accounts" value="all" checked> All accounts, including ones added later</label>
    <label><input type="radio" name="scope_accounts" value="chosen"> Only these:</label>
    <div style="padding-left:22px">${accounts || '<span class="dim">No accounts yet.</span>'}</div></fieldset>
  <div class="actions">
    <button class="primary" type="submit" name="decision" value="allow">Allow</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`);
}
