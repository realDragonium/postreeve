import type { AccountDiscovery, MailProviderId } from "../shared/contracts";

const providerNames: Record<MailProviderId, string> = {
  icloud: "iCloud Mail",
  fastmail: "Fastmail",
  yahoo: "Yahoo Mail",
  aol: "AOL Mail",
  zoho: "Zoho Mail",
  gmx: "GMX",
  gmail: "Gmail",
  outlook: "Outlook.com",
  proton: "Proton Mail",
};

export function discoveryStatus(result: AccountDiscovery, email: string): string {
  const provider = result.provider ? providerNames[result.provider] : null;
  if (!result.settings) {
    return provider
      ? `This address uses ${provider}.`
      : "No settings found for this address. Enter them from your provider's instructions.";
  }
  const check = "Check them before connecting.";
  switch (result.source) {
    case "provider": return `Filled in from Postreeve's provider list for ${provider ?? "this provider"}. ${check}`;
    case "mx": return `${provider ?? "A known provider"} handles mail for this domain; filled in its settings. ${check}`;
    case "autoconfig": return `Filled in from settings published by ${email.slice(email.lastIndexOf("@") + 1)}. ${check}`;
    case "ispdb": return `Filled in from the Thunderbird provider database. ${check}`;
    case null: return check;
  }
}

/** Fixed copy only: nothing from a lookup response is shown to the user. */
export function providerGuidance(provider: MailProviderId | null, googleConfigured: boolean): string | null {
  switch (provider) {
    case "icloud":
      return "iCloud Mail needs an app-specific password: create one at account.apple.com under Sign-In and Security and use it as the password. If sign-in fails with a custom-domain address, use your @icloud.com address as the username.";
    case "fastmail":
      return "Fastmail needs an app password: create one in Fastmail under Settings → Privacy & Security → App passwords with IMAP and SMTP access, and use it as the password.";
    case "yahoo":
      return "Yahoo needs an app password: generate one in Yahoo Account Security and use it as the password.";
    case "aol":
      return "AOL needs an app password: generate one in AOL Account Security and use it as the password.";
    case "gmx":
      return "Turn on IMAP access in GMX settings before connecting. With two-factor authentication on, use an app-specific password.";
    case "zoho":
      return "Turn on IMAP access in Zoho Mail settings before connecting. With two-factor authentication on, use an app-specific password.";
    case "gmail":
      return googleConfigured
        ? "This is a Google account. Use Continue with Google above instead of a password; your Google password never enters Postreeve."
        : "Gmail over IMAP needs a Google app password, which requires 2-Step Verification. Configuring Google sign-in on this server enables Continue with Google instead.";
    case "outlook":
      return "Outlook.com, Hotmail and Microsoft 365 require Microsoft sign-in, which Postreeve does not support yet. These addresses cannot be connected with a password.";
    case "proton":
      return "Proton Mail works only through Proton Mail Bridge, whose self-signed certificate Postreeve does not trust yet. These addresses cannot be connected yet.";
    case null:
      return null;
  }
}
