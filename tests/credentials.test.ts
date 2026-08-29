import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { CredentialVault } from "../src/server/security/credentials";

describe("CredentialVault", () => {
  test("encrypts authenticated IMAP credentials outside the database key", () => {
    const key = randomBytes(32).toString("base64");
    const vault = new CredentialVault(key);
    const credentials = {
      imap: {
        host: "imap.example.com",
        port: 993,
        secure: true,
        username: "human@example.com",
        password: "correct horse battery staple",
      },
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        username: "human@example.com",
        password: "second secret",
      },
    };
    const encrypted = vault.encrypt(credentials);

    expect(encrypted).not.toContain(credentials.imap.password);
    expect(vault.decrypt(encrypted)).toEqual(credentials);
    expect(() => new CredentialVault(randomBytes(32).toString("base64")).decrypt(encrypted)).toThrow();
  });

  test("requires an external master key for IMAP credentials", () => {
    const vault = new CredentialVault("");
    expect(() => vault.encrypt({
      imap: { host: "imap.example.com", port: 993, secure: true, username: "u", password: "p" },
      smtp: null,
    }))
      .toThrow("POSTREEVE_MASTER_KEY");
  });
});
