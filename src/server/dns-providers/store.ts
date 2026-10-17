import type { Database } from "bun:sqlite";
import type { DnsProvider, DnsProviderKind } from "../../shared/dns-providers";

const migrationVersion = 910002;

export function migrateDnsProviders(sqlite: Database): void {
  if (sqlite.query("SELECT 1 FROM schema_migrations WHERE version = ?").get(migrationVersion)) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS dns_providers (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('cloudflare', 'godaddy')),
        encrypted_credential TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dns_owned_records (
        provider_id TEXT NOT NULL REFERENCES dns_providers(id) ON DELETE CASCADE,
        zone TEXT NOT NULL, record_key TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, zone, record_key)
      );
    `);
    sqlite.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)").run(migrationVersion);
  })();
}

export type StoredDnsProvider = DnsProvider & { readonly encryptedCredential: string };
interface Row { id: string; name: string; kind: DnsProviderKind; encrypted_credential: string; created_at: string }
const fromRow = (row: Row): StoredDnsProvider =>
  ({ id: row.id, name: row.name, kind: row.kind, createdAt: row.created_at, encryptedCredential: row.encrypted_credential });

/** Providers and the ledger of DNS records Postreeve created, which decides what it may change unasked. */
export class DnsProviderStore {
  readonly #sqlite: Database;

  constructor(sqlite: Database) {
    this.#sqlite = sqlite;
  }

  list(): StoredDnsProvider[] {
    return this.#sqlite.query<Row, []>("SELECT * FROM dns_providers ORDER BY created_at, id").all().map(fromRow);
  }

  get(id: string): StoredDnsProvider | null {
    const row = this.#sqlite.query<Row, [string]>("SELECT * FROM dns_providers WHERE id = ?").get(id);
    return row ? fromRow(row) : null;
  }

  insert(provider: StoredDnsProvider): void {
    this.#sqlite.query("INSERT INTO dns_providers (id, name, kind, encrypted_credential, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(provider.id, provider.name, provider.kind, provider.encryptedCredential, provider.createdAt);
  }

  delete(id: string): void {
    this.#sqlite.transaction(() => {
      this.#sqlite.query("DELETE FROM dns_owned_records WHERE provider_id = ?").run(id);
      this.#sqlite.query("DELETE FROM dns_providers WHERE id = ?").run(id);
    })();
  }

  owned(providerId: string, zone: string): Set<string> {
    return new Set(this.#sqlite.query<{ record_key: string }, [string, string]>(
      "SELECT record_key FROM dns_owned_records WHERE provider_id = ? AND zone = ?").all(providerId, zone).map(({ record_key }) => record_key));
  }

  own(providerId: string, zone: string, key: string, at: string): void {
    this.#sqlite.query("INSERT OR IGNORE INTO dns_owned_records (provider_id, zone, record_key, created_at) VALUES (?, ?, ?, ?)").run(providerId, zone, key, at);
  }

  disown(providerId: string, zone: string, key: string): void {
    this.#sqlite.query("DELETE FROM dns_owned_records WHERE provider_id = ? AND zone = ? AND record_key = ?").run(providerId, zone, key);
  }
}
