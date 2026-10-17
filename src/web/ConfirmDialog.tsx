import { useEffect, useRef, type ReactNode } from "react";

/** A destructive confirmation. Cancel has focus, so Enter or a stray key press never confirms. */
export function ConfirmDialog({ title, children, confirmLabel, busy, error, onConfirm, onCancel }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return <div className="overlay" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}>
    <div className="backdrop" onClick={busy ? undefined : onCancel} />
    <section className="sheet confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
      <div className="sheet-head"><h2 id="confirm-title" style={{ fontSize: 15 }}>{title}</h2></div>
      <div className="sheet-body" id="confirm-body">
        {children}
        {error ? <div className="alert error" role="alert">{error}</div> : null}
      </div>
      <div className="sheet-foot">
        <button ref={cancel} className="chip" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="btn btn-destructive push" disabled={busy} onClick={onConfirm}>{busy ? "Deleting…" : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
