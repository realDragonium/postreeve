import { z } from "zod";
import type { RecipientSuggestion } from "../shared/contracts";

/** The address being typed: the text after the last comma. */
export function currentRecipientToken(value: string): string {
  return value.slice(value.lastIndexOf(",") + 1).trim();
}

/** Replaces the address being typed with `address`, ready for the next one. */
export function acceptRecipient(value: string, address: string): string {
  const comma = value.lastIndexOf(",");
  return `${comma < 0 ? "" : `${value.slice(0, comma + 1)} `}${address}, `;
}

/**
 * The suggestion active before any arrow key: the first one when its address or name starts with `token`,
 * and none when `token` is already a complete address, so Enter or Tab never silently swaps a typed recipient.
 */
export function initialSuggestion(token: string, suggestions: readonly RecipientSuggestion[]): number | null {
  const first = suggestions[0];
  if (!first || z.email().safeParse(token).success) return null;
  const typed = token.toLowerCase();
  return first.address.startsWith(typed) || first.name.toLowerCase().startsWith(typed) ? 0 : null;
}
