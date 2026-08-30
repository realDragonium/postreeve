import type { Account, Folder } from "../shared/contracts";
import { assistantTools } from "./assistant-tools";
import { railFor, type ThemePreference } from "./theme";

export const settingsSections = [
  "Accounts",
  "Assistant control",
  "Appearance",
  "Keyboard shortcuts",
  "Rules & filters",
  "Sync & storage",
] as const;

export type SettingsSection = (typeof settingsSections)[number];

const shortcuts: readonly (readonly [string, string])[] = [
  ["↵ / click", "open the focused message"],
  ["esc", "back to the list"],
  ["j / ↓", "move down"],
  ["k / ↑", "move up"],
  ["x", "add the focused message to the selection"],
  ["⌘-click", "add one message to the selection"],
  ["shift-click", "select a range"],
  ["e", "archive the selection"],
  ["u", "toggle read and unread"],
  ["/", "focus the search box"],
  ["[", "hide or show the sidebar"],
  ["⌘Z", "undo the last batch of operations"],
];

function Toolbar({ title, meta, action }: { title: string; meta: string; action?: React.ReactNode }) {
  return <div className="toolbar">
    <span className="scope-title">{title}</span>
    <span className="t-dim">{meta}</span>
    {action ? <span style={{ marginLeft: "auto" }}>{action}</span> : null}
  </div>;
}

function NotBuilt({ title, body }: { title: string; body: string }) {
  return <>
    <Toolbar title={title} meta="not built" />
    <div className="readscroll"><div className="pad">
      <p className="t-body" style={{ maxWidth: 760, margin: 0 }}>{body}</p>
    </div></div>
  </>;
}

export interface SettingsViewProps {
  section: SettingsSection;
  accounts: readonly Account[];
  foldersByAccount: ReadonlyMap<string, readonly Folder[]>;
  googleConfigured: boolean;
  themePreference: ThemePreference;
  themeMode: "light" | "dark";
  hiddenTools: ReadonlySet<string>;
  onThemePreference: (preference: ThemePreference) => void;
  onToolExposure: (name: string, exposed: boolean) => void;
  onManageAccount: (accountId: string) => void;
  onManageIdentities: (accountId: string) => void;
  onAddAccount: () => void;
}

export function SettingsView(props: SettingsViewProps) {
  if (props.section === "Appearance") {
    return <>
      <Toolbar
        title="Appearance"
        meta={`Currently ${props.themeMode}${props.themePreference === "system" ? " — following your system preference" : " — set by hand"}`}
      />
      <div className="readscroll"><div className="pad">
        <div className="t-sec" style={{ marginBottom: 10 }}>Theme</div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              key={option}
              className={`opt opt-accent ${props.themePreference === option ? "on" : ""}`}
              style={{ padding: "4px 10px", background: props.themePreference === option ? undefined : "var(--field)" }}
              aria-pressed={props.themePreference === option}
              onClick={() => props.onThemePreference(option)}
            >{option.charAt(0).toUpperCase()}{option.slice(1)}</button>
          ))}
        </div>
        <p className="t-body" style={{ maxWidth: 720, margin: "14px 0 0" }}>
          System follows your operating system and switches with it. Light and Dark pin the interface until you change it back.
        </p>
      </div></div>
    </>;
  }

  if (props.section === "Keyboard shortcuts") {
    return <>
      <Toolbar title="Keyboard shortcuts" meta={`${shortcuts.length} bindings · active in the mailbox`} />
      <div className="readscroll"><div className="pad" style={{ "--grid-cols": "120px minmax(0,1fr)" } as React.CSSProperties}>
        <div className="grid-head"><span className="t-sec">Key</span><span className="t-sec">Does</span></div>
        <div className="thin" />
        {shortcuts.map(([key, description]) => (
          <div className="grid-row" key={key}>
            <span className="t-ink t-num" style={{ fontSize: 11 }}>{key}</span>
            <span className="t-body">{description}</span>
          </div>
        ))}
        <p className="t-dim" style={{ maxWidth: 760, margin: "20px 0 0" }}>
          Shortcuts are ignored while a text field has focus, so typing in search never triggers an operation.
        </p>
      </div></div>
    </>;
  }

  if (props.section === "Assistant control") {
    const exposedCount = assistantTools.length - props.hiddenTools.size;
    return <>
      <Toolbar title="Assistant control" meta={`${exposedCount} exposed · ${props.hiddenTools.size} hidden`} />
      <div className="readscroll"><div className="pad" style={{ "--grid-cols": "minmax(160px,220px) minmax(120px,180px) 90px 90px", maxWidth: 704 } as React.CSSProperties}>
        <p className="t-body" style={{ maxWidth: 820, margin: "0 0 18px" }}>
          The assistant runs in your browser and calls the operations this page offers, as you, in this session. It can do
          nothing you could not do yourself — so the only decision here is which operations are offered. Changing a row
          re-registers the tools immediately.
        </p>
        <div className="grid-head">
          <span className="t-sec">Tool</span>
          <span className="t-sec">Effect</span>
          <span className="t-sec" style={{ textAlign: "center" }}>Exposed</span>
          <span className="t-sec" style={{ textAlign: "center" }}>Hidden</span>
        </div>
        <div className="thin" />
        {assistantTools.map((tool) => {
          const hidden = props.hiddenTools.has(tool.name);
          return <div className="grid-row" key={tool.name} style={{ height: 26 }}>
            <span className="t-ink" style={{ fontSize: 11 }}>{tool.name}</span>
            <span className="t-dim">{tool.effect}</span>
            {([false, true] as const).map((wantHidden) => (
              <button
                key={String(wantHidden)}
                className="opt"
                style={{ height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: hidden === wantHidden ? "var(--field)" : "transparent" }}
                aria-pressed={hidden === wantHidden}
                aria-label={`${wantHidden ? "Hide" : "Expose"} ${tool.name}`}
                onClick={() => props.onToolExposure(tool.name, !wantHidden)}
              >{hidden === wantHidden ? (wantHidden ? "–" : "◆") : ""}</button>
            ))}
          </div>;
        })}
        <p className="t-dim" style={{ maxWidth: 820, margin: "18px 0 0" }}>
          A confirm-first tier, where a write tool stops as a proposal until you accept it, is not built yet: nothing in the
          server can hold a tool call open. Until it is, <code>send_message</code> is the one irreversible tool here — hide it
          if you would rather the assistant never sent mail on your behalf.
        </p>
      </div></div>
    </>;
  }

  if (props.section === "Accounts") {
    return <>
      <Toolbar
        title="Accounts"
        meta={`${props.accounts.length} connected${props.accounts.length > 1 ? " · unified inbox on" : ""}`}
        action={<button className="btn" onClick={props.onAddAccount}>Add account</button>}
      />
      <div className="readscroll"><div className="pad">
        {props.accounts.map((account) => {
          const folders = props.foldersByAccount.get(account.id) ?? [];
          const unread = folders.reduce((total, folder) => total + folder.unread, 0);
          const details: readonly (readonly [string, string])[] = [
            ["Provider", account.kind === "gmail" ? "Gmail · Google OAuth" : "IMAP / SMTP"],
            ["Display name", account.name],
            ["Folders", folders.length ? `${folders.length} subscribed` : "not loaded"],
            ["Unread", unread ? String(unread) : "none"],
          ];
          return <div key={account.id}>
            <div style={{ display: "grid", gridTemplateColumns: "2px minmax(0,1fr)", padding: "16px 0" }}>
              <div style={{ width: 2, background: railFor(account.id) }} />
              <div style={{ paddingLeft: 14, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{account.email}</span>
                  <span className="t-body">{account.kind === "gmail" ? "Gmail" : "IMAP"}</span>
                  <span style={{ display: "flex", gap: 16, marginLeft: "auto" }}>
                    {account.kind === "gmail" ? <a className="btn-quiet" href="/api/oauth/google/start">Reauthorise</a> : null}
                    <button className="btn-quiet" onClick={() => props.onManageIdentities(account.id)}>Identities</button>
                    <button className="btn-quiet" onClick={() => props.onManageAccount(account.id)}>Manage</button>
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: "4px 20px", marginTop: 12 }}>
                  {details.map(([label]) => <span key={label} className="t-sec">{label}</span>)}
                  {details.map(([label, value]) => <span key={label} className="t-body truncate">{value}</span>)}
                </div>
              </div>
            </div>
            <div className="thin" />
          </div>;
        })}

        <div className="strong" style={{ margin: "20px 0 0" }} />
        <div style={{ paddingTop: 18 }}>
          <div className="t-sec" style={{ marginBottom: 10 }}>Connect another account</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "0 32px", maxWidth: 840 }}>
            <div style={{ paddingRight: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Gmail / Google Workspace</div>
              <p className="t-body" style={{ margin: "8px 0 12px", maxWidth: 340 }}>
                One OAuth grant. Labels arrive as folders. Your Google password never enters Postreeve.
              </p>
              {props.googleConfigured
                ? <a className="chip" href="/api/oauth/google/start">Continue with Google</a>
                : <span className="t-dim">Set the Google OAuth environment variables on the server to enable this.</span>}
            </div>
            <div style={{ paddingRight: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>IMAP / SMTP</div>
              <p className="t-body" style={{ margin: "8px 0 12px", maxWidth: 340 }}>
                Any self-hosted or third-party server. Both connections are tested before anything is saved.
              </p>
              <button className="chip" onClick={props.onAddAccount}>Enter server details</button>
            </div>
          </div>
        </div>
      </div></div>
    </>;
  }

  if (props.section === "Rules & filters") {
    return <NotBuilt
      title="Rules & filters"
      body="Postreeve has no rules engine yet. The pieces it would need already exist — the triage operations, the batch log and the undo path are all real — but nothing evaluates conditions against arriving mail, so there is no rule to show or edit here. Until that lands, the assistant and you apply the same operations by hand, and every one of them is listed under Activity."
    />;
  }

  return <NotBuilt
    title="Sync & storage"
    body="Sync runs on a fixed fifteen-second folder poll with no settings to change, and message bodies are fetched on demand rather than stored. There is nothing to configure here until Postreeve keeps a local cache worth managing."
  />;
}
