import { useState, type FormEvent, type ReactNode } from "react";
import { Sheet } from "../panels";

export function Toolbar({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="toolbar">
    <span className="scope-title">{title}</span>
    {meta ? <span className="t-dim">{meta}</span> : null}
    {action ? <span style={{ marginLeft: "auto", display: "flex", gap: 16 }}>{action}</span> : null}
  </div>;
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="alert error" role="alert">{error instanceof Error ? error.message : "Request failed"}</p>;
}

/** A confirmation sheet; with `typed`, the person must type that text before confirming. */
export function ConfirmSheet({ title, body, typed, action, pending, error, onConfirm, onClose }: {
  title: string; body: ReactNode; typed?: string; action: string; pending: boolean; error: unknown;
  onConfirm: (typedValue: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const ready = !typed || value.trim().toLowerCase() === typed.toLowerCase();
  return <Sheet title={title} onClose={onClose} closeDisabled={pending}
    onSubmit={(event: FormEvent) => { event.preventDefault(); if (ready) onConfirm(value.trim()); }}
    footer={<>
      <button type="submit" className="btn" disabled={!ready || pending}>{pending ? "Working…" : action}</button>
      <button type="button" className="btn-quiet push" onClick={onClose} disabled={pending}>Cancel</button>
    </>}>
    <div className="t-body">{body}</div>
    {typed ? <label className="field"><span className="field-label">Type {typed} to confirm</span>
      <input className="input" autoFocus value={value} onChange={(event) => setValue(event.target.value)} aria-label={`Type ${typed} to confirm`} /></label> : null}
    <ErrorLine error={error} />
  </Sheet>;
}

export async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); } catch { /* the browser refused; the value stays visible to copy by hand */ }
}
