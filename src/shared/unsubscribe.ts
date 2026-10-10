import { z } from "zod";

/** The sender writes these fields but the person sends them, so they stay short enough to show in the confirmation. */
const MAX_MAILTO_FIELD_LENGTH = 500;

/** RFC 6068 fields of a single-address `mailto:` URI, defaulting subject and body to `unsubscribe`. */
export function mailtoUnsubscribe(uri: string): { address: string; subject: string; body: string } {
  const [target = "", query = ""] = uri.slice("mailto:".length).split("?", 2);
  const fields = new Map<string, string>();
  for (const pair of query.split("&")) {
    const [name = "", value = ""] = pair.split("=", 2);
    if (name) fields.set(safeDecode(name).toLowerCase(), safeDecode(value));
  }
  const address = safeDecode(target).trim();
  if (!z.email().safeParse(address).success) throw new Error("The unsubscribe email address is not a single valid address");
  const subject = fields.get("subject")?.trim() || "unsubscribe";
  const body = fields.get("body")?.trim() || "unsubscribe";
  if (subject.length > MAX_MAILTO_FIELD_LENGTH || body.length > MAX_MAILTO_FIELD_LENGTH) {
    throw new Error("The unsubscribe email's subject or body is too long to send");
  }
  return { address, subject, body };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
