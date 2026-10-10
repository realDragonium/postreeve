import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { acceptRecipient, currentRecipientToken } from "./recipient-token";

const LOOKUP_DELAY_MS = 150;

export function RecipientInput({ label, value, onChange, disabled, autoFocus = false, required = false, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
  required?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const token = currentRecipientToken(value).slice(0, 100);
  const [lookup, setLookup] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setLookup(token), LOOKUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [token]);
  const suggestions = useQuery({
    queryKey: ["recipient-suggestions", lookup],
    queryFn: ({ signal }) => api.recipientSuggestions(lookup, signal),
    enabled: open && lookup.length > 0,
    staleTime: 30_000,
  });
  const options = open && lookup === token && token ? suggestions.data ?? [] : [];
  const shown = options.length > 0;
  useEffect(() => setActive(0), [suggestions.data]);

  function accept(address: string): void {
    onChange(acceptRecipient(value, address));
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!shown) return;
    const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (move) {
      setActive((current) => (current + move + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      accept(options[Math.min(active, options.length - 1)]!.address);
    } else if (event.key === "Escape") {
      setOpen(false);
      event.stopPropagation();
    } else {
      return;
    }
    event.preventDefault();
  }

  return <label className="field recipient-field"><span className="field-label">{label}</span>
    <input className="input" aria-label={label} role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls={listId}
      aria-activedescendant={shown ? `${listId}-${active}` : undefined} autoComplete="off"
      autoFocus={autoFocus} required={required} placeholder={placeholder} value={value} disabled={disabled}
      onChange={(event) => { onChange(event.target.value); setOpen(true); }}
      onKeyDown={onKeyDown} onBlur={() => setOpen(false)} />
    {shown ? <ul className="recipient-suggestions" id={listId} role="listbox" aria-label={`${label} suggestions`}>
      {options.map((option, index) => <li key={option.address} id={`${listId}-${index}`} role="option" aria-selected={index === active}
        className={index === active ? "on" : undefined}
        onMouseDown={(event) => { event.preventDefault(); accept(option.address); }}>
        {option.name ? <><span className="t-body">{option.name}</span> <span className="t-dim">{option.address}</span></> : <span className="t-body">{option.address}</span>}
      </li>)}
    </ul> : null}
  </label>;
}
