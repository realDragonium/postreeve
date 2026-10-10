/** The address being typed: the text after the last comma. */
export function currentRecipientToken(value: string): string {
  return value.slice(value.lastIndexOf(",") + 1).trim();
}

/** Replaces the address being typed with `address`, ready for the next one. */
export function acceptRecipient(value: string, address: string): string {
  const comma = value.lastIndexOf(",");
  return `${comma < 0 ? "" : `${value.slice(0, comma + 1)} `}${address}, `;
}
