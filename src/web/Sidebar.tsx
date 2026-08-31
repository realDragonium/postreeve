import type { Account, Folder } from "../shared/contracts";
import type { MessageFilter } from "./mail-ui-state";
import {
  scopeGroupId,
  specialUseName,
  unifiedFolders,
  type Scope,
} from "./mail-view";
import { railFor } from "./theme";

const filters: readonly MessageFilter[] = ["all", "unread", "flagged"];
const filterLabels: Record<MessageFilter, string> = { all: "All", unread: "Unread", flagged: "Flagged" };

function Counts({ awaiting, unread, total }: { awaiting: number; unread: number; total?: number }) {
  return <>
    {awaiting > 0 ? <span className="mark-propose" title={`${awaiting} awaiting you`}>◇{total === undefined ? ` ${awaiting}` : ""}</span> : null}
    {unread > 0 ? <span className="count-unread t-num">{unread}</span> : null}
    {total === undefined ? null : <span className="t-dim t-num frow-total">{total}</span>}
  </>;
}

function FolderRow({ name, depth, active, awaiting, unread, total, separated, onSelect }: {
  name: string;
  depth: number;
  active: boolean;
  awaiting: number;
  unread: number;
  total: number;
  separated: boolean;
  onSelect: () => void;
}) {
  return <>
    {separated ? <div className="fsep" /> : null}
    <button className={`frow ${depth > 1 ? "nested" : ""} ${active ? "on" : ""}`} aria-current={active} onClick={onSelect}>
      <span className="frow-name truncate">{name}</span>
      <Counts awaiting={awaiting} unread={unread} total={total} />
    </button>
  </>;
}

export interface SidebarProps {
  accounts: readonly Account[];
  foldersByAccount: ReadonlyMap<string, readonly Folder[]>;
  awaitingByAccount: ReadonlyMap<string, number>;
  scope: Scope;
  filter: MessageFilter;
  view: "mail" | "activity" | "settings";
  section: string;
  sections: readonly string[];
  onScope: (scope: Scope) => void;
  onFilter: (filter: MessageFilter) => void;
  onView: (view: "mail" | "activity" | "settings") => void;
  onSection: (section: string) => void;
  onManageFolders: (accountId: string) => void;
  onDrafts: () => void;
  draftCount: number;
}

export function Sidebar(props: SidebarProps) {
  if (props.view === "settings") {
    return <>
      <div>
        <div className="t-sec sec">Settings</div>
        {props.sections.map((section) => (
          <button
            key={section}
            className={`nav-row ${section === props.section ? "on" : ""}`}
            aria-current={section === props.section}
            onClick={() => props.onSection(section)}
          >{section}</button>
        ))}
      </div>
      <div className="side-foot">
        <button className="btn-quiet" style={{ fontWeight: 500 }} onClick={() => props.onView("mail")}>← Back to mailbox</button>
      </div>
    </>;
  }

  const openGroup = props.view === "mail" ? scopeGroupId(props.scope) : "";
  const unified = unifiedFolders(props.foldersByAccount);
  const totalAwaiting = [...props.awaitingByAccount.values()].reduce((total, count) => total + count, 0);
  const unifiedUnread = unified.find((folder) => folder.specialUse === "inbox")?.unread ?? 0;

  return <>
    <div>
      <div className="t-sec sec">Mailboxes</div>

      {props.accounts.length > 1 ? <>
        <button className={`group ${openGroup === "unified" ? "on" : ""}`} onClick={() => props.onScope({ kind: "unified", specialUse: "inbox" })}>
          <span className="group-rail" style={{ background: "var(--ink)" }} />
          <span className="group-text">
            <span className="group-name truncate">Unified</span>
            <span className="t-dim truncate">{props.accounts.length} accounts · 1 view</span>
          </span>
          <span className="group-count"><Counts awaiting={totalAwaiting} unread={unifiedUnread} /></span>
        </button>
        {openGroup === "unified" ? <>
          {unified.map((folder) => (
            <FolderRow
              key={folder.specialUse}
              name={folder.name}
              depth={1}
              separated={false}
              active={props.scope.kind === "unified" && props.scope.specialUse === folder.specialUse}
              awaiting={0}
              unread={folder.unread}
              total={folder.total}
              onSelect={() => props.onScope({ kind: "unified", specialUse: folder.specialUse })}
            />
          ))}
          <div className="t-dim" style={{ padding: "8px 16px 4px 32px" }}>Custom folders live under each account</div>
        </> : null}
      </> : null}

      {props.accounts.map((account) => {
        const open = openGroup === account.id;
        const folders = props.foldersByAccount.get(account.id) ?? [];
        const inbox = folders.find((folder) => folder.specialUse === "inbox") ?? folders[0];
        const awaiting = props.awaitingByAccount.get(account.id) ?? 0;
        return <div key={account.id}>
          <button
            className={`group ${open ? "on" : ""}`}
            onClick={() => props.onScope({ kind: "account", accountId: account.id, path: inbox?.path ?? "" })}
          >
            <span className="group-rail" style={{ background: railFor(account.id) }} />
            <span className="group-text">
              <span className="group-name truncate">{account.email}</span>
              <span className="t-dim truncate">{account.kind === "gmail" ? "Gmail" : "IMAP"} · {account.name}</span>
            </span>
            <span className="group-count"><Counts awaiting={awaiting} unread={inbox?.unread ?? 0} /></span>
          </button>
          {open ? <>
            {folders.map((folder, index) => (
              <FolderRow
                key={folder.path}
                name={folder.name}
                depth={folder.path.split(/[/.]/).length}
                separated={folder.specialUse === null && folders[index - 1]?.specialUse !== null}
                active={props.scope.kind === "account" && props.scope.accountId === account.id && props.scope.path === folder.path}
                awaiting={0}
                unread={folder.unread}
                total={folder.total}
                onSelect={() => props.onScope({ kind: "account", accountId: account.id, path: folder.path })}
              />
            ))}
            <div style={{ padding: "8px 16px 4px 32px" }}>
              <button className="btn-quiet" aria-label="Manage folders" onClick={() => props.onManageFolders(account.id)}>Manage folders</button>
            </div>
          </> : null}
        </div>;
      })}

      <div className="filters">
        {filters.map((filter) => (
          <button
            key={filter}
            className={`opt ${filter !== "all" ? "opt-accent" : ""}`}
            aria-pressed={filter === props.filter}
            onClick={() => props.onFilter(filter)}
          >{filterLabels[filter]}</button>
        ))}
      </div>
    </div>

    <div>
      <div className="thin" />
      <button className="side-entry" onClick={props.onDrafts}>
        <span className="side-entry-name">Local drafts</span>
        <span className="t-dim t-num" style={{ marginLeft: "auto" }}>{props.draftCount || ""}</span>
      </button>
      <button className={`side-entry ${props.view === "activity" ? "on" : ""}`} onClick={() => props.onView("activity")}>
        <span className="side-entry-name">Activity</span>
        <span className="t-dim" style={{ marginLeft: "auto" }}>every operation, undoable</span>
      </button>
    </div>
  </>;
}

export { specialUseName };
