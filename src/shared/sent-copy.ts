// These providers file SMTP submissions in Sent themselves, so an appended copy would duplicate it.
const selfFilingDomains = ["gmail.com", "googlemail.com", "outlook.com", "office365.com"];

export function defaultSaveSentCopy(imapHost: string): boolean {
  const host = imapHost.trim().toLowerCase().replace(/\.$/, "");
  return !selfFilingDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
