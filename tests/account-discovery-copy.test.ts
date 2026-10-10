import { expect, test } from "bun:test";
import { mailProviderIds } from "../src/shared/contracts";
import { discoveryStatus, providerGuidance } from "../src/web/account-discovery";

const settings = {
  host: "imap.example.test", port: 993, secure: true, username: "person@example.test",
  smtpHost: "smtp.example.test", smtpPort: 465, smtpSecure: true, smtpUsername: "person@example.test",
};

test("names where proposed settings came from", () => {
  expect(discoveryStatus({ provider: "icloud", source: "provider", settings }, "person@icloud.com"))
    .toStartWith("Filled in from Postreeve's provider list for iCloud Mail.");
  expect(discoveryStatus({ provider: null, source: "autoconfig", settings }, "person@example.test"))
    .toStartWith("Filled in from settings published by example.test.");
  expect(discoveryStatus({ provider: null, source: null, settings: null }, "person@example.test"))
    .toStartWith("No settings found");
});

test("gives fixed guidance for every known provider and steers Gmail to Google when configured", () => {
  for (const provider of mailProviderIds) expect(providerGuidance(provider, false)).toBeString();
  expect(providerGuidance("yahoo", false)).toContain("app password");
  expect(providerGuidance("gmail", true)).toContain("Continue with Google");
  expect(providerGuidance("gmail", false)).toContain("app password");
  expect(providerGuidance(null, true)).toBeNull();
});
