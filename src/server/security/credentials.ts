import { z } from "zod";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const imapCredentialsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export type ImapCredentials = z.infer<typeof imapCredentialsSchema>;

export const smtpCredentialsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export const accountCredentialsSchema = z.object({
  imap: imapCredentialsSchema,
  smtp: smtpCredentialsSchema.nullable(),
});

export type SmtpCredentials = z.infer<typeof smtpCredentialsSchema>;
export type AccountCredentials = z.infer<typeof accountCredentialsSchema>;

const envelopeSchema = z.object({
  iv: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

export class CredentialVault {
  readonly #key: Buffer | null;

  constructor(encodedKey = process.env.POSTREEVE_MASTER_KEY) {
    if (!encodedKey) {
      this.#key = null;
      return;
    }
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) throw new Error("POSTREEVE_MASTER_KEY must be a base64-encoded 32-byte key");
    this.#key = key;
  }

  encrypt(credentials: AccountCredentials): string {
    const key = this.#requiredKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(accountCredentialsSchema.parse(credentials)), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
    });
  }

  decrypt(value: string): AccountCredentials {
    const key = this.#requiredKey();
    const envelope = envelopeSchema.parse(JSON.parse(value));
    const iv = Buffer.from(envelope.iv, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (tag.length !== 16) throw new Error("Stored account credentials failed authentication");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    const current = accountCredentialsSchema.safeParse(parsed);
    if (current.success) return current.data;
    return { imap: imapCredentialsSchema.parse(parsed), smtp: null };
  }

  #requiredKey(): Buffer {
    if (!this.#key) throw new Error("Set POSTREEVE_MASTER_KEY before adding or using IMAP accounts");
    return this.#key;
  }
}
