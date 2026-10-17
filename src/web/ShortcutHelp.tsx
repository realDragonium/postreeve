import { useEffect, useRef } from "react";
import { shortcutGroups } from "./keyboard";

export function ShortcutTable() {
  return <div className="shortcut-groups">
    {shortcutGroups.map((group) => <section key={group.title} aria-label={group.title}>
      <div className="t-sec" style={{ marginBottom: 6 }}>{group.title}</div>
      <dl className="shortcut-list">
        {group.entries.map(({ keys, description }) => <div key={keys} className="shortcut-row">
          <dt><kbd>{keys}</kbd></dt>
          <dd className="t-body">{description}</dd>
        </div>)}
      </dl>
    </section>)}
  </div>;
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return <div className="overlay">
    <div className="backdrop" onClick={onClose} />
    <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
      <div className="sheet-head">
        <h2 id="shortcut-help-title" style={{ fontSize: 15 }}>Keyboard shortcuts</h2>
        <span className="t-dim">ignored while typing or in a dialog</span>
        <button ref={close} className="btn-quiet" style={{ marginLeft: "auto" }} onClick={onClose}>Close</button>
      </div>
      <div className="sheet-body"><ShortcutTable /></div>
    </section>
  </div>;
}
