import type { UnsubscribeOptions } from "../shared/contracts";
import { mailtoUnsubscribe } from "../shared/unsubscribe";

export type UnsubscribePlan =
  | { readonly kind: "one_click"; readonly confirmation: string }
  | { readonly kind: "mailto"; readonly confirmation: string }
  | { readonly kind: "link"; readonly url: string; readonly confirmation: string };

/** Prefers RFC 8058 one-click, then email, then opening the link; the confirmation names the external target. */
export function unsubscribePlan(options: UnsubscribeOptions): UnsubscribePlan | null {
  if (options.oneClick && options.https) {
    return { kind: "one_click", confirmation: `Unsubscribe now? Postreeve will send a one-click unsubscribe request to ${new URL(options.https).hostname}.` };
  }
  const mail = options.mailto ? sendableMailto(options.mailto) : null;
  if (mail) {
    return {
      kind: "mailto",
      confirmation: `Unsubscribe by email? Postreeve will send this message to ${mail.address} from the address this message was delivered to.\n\nSubject: ${mail.subject}\n\n${mail.body}`,
    };
  }
  if (options.https) {
    return { kind: "link", url: options.https, confirmation: `Open the sender's unsubscribe page at ${new URL(options.https).hostname} in your browser?` };
  }
  return null;
}

function sendableMailto(uri: string): ReturnType<typeof mailtoUnsubscribe> | null {
  try {
    return mailtoUnsubscribe(uri);
  } catch {
    return null;
  }
}
