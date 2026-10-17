import type { Database } from "bun:sqlite";
import {
  mailServerOperationSchema,
  mailServerProposalSchema,
  type MailServer,
  type MailServerProposal,
} from "../../shared/mail-server";
import { z } from "zod";

const migrationVersion = 910001;

export function migrateMailServers(sqlite: Database): void {
  if (sqlite.query("SELECT 1 FROM schema_migrations WHERE version = ?").get(migrationVersion)) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mail_servers (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
        credential_kind TEXT NOT NULL CHECK (credential_kind IN ('apiKey', 'basic')),
        encrypted_credential TEXT NOT NULL, mail_hostname TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_server_proposals (
        id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT NOT NULL REFERENCES mail_servers(id) ON DELETE CASCADE,
        title TEXT NOT NULL, created_by TEXT NOT NULL, operations TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'applying', 'applied', 'failed', 'rejected')),
        results TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_server_proposals_server_idx ON mail_server_proposals(server_id, created_at);
    `);
    sqlite.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)").run(migrationVersion);
  })();
}

export type StoredMailServer = MailServer & { readonly encryptedCredential: string };

interface ServerRow {
  id: string; name: string; base_url: string; credential_kind: "apiKey" | "basic";
  encrypted_credential: string; mail_hostname: string; created_at: string; updated_at: string;
}

interface ProposalRow {
  id: string; server_id: string; title: string; created_by: string; operations: string;
  status: MailServerProposal["status"]; results: string; created_at: string; decided_at: string | null;
}

const serverFromRow = (row: ServerRow): StoredMailServer => ({
  id: row.id, name: row.name, baseUrl: row.base_url, credentialKind: row.credential_kind,
  mailHostname: row.mail_hostname, createdAt: row.created_at, updatedAt: row.updated_at,
  encryptedCredential: row.encrypted_credential,
});

const proposalFromRow = (row: ProposalRow): MailServerProposal => mailServerProposalSchema.parse({
  id: row.id, serverId: row.server_id, title: row.title, createdBy: row.created_by,
  operations: z.array(mailServerOperationSchema).parse(JSON.parse(row.operations)),
  status: row.status, results: JSON.parse(row.results), createdAt: row.created_at, decidedAt: row.decided_at,
});

export class MailServerStore {
  readonly #sqlite: Database;

  constructor(sqlite: Database) {
    this.#sqlite = sqlite;
  }

  listServers(): StoredMailServer[] {
    return this.#sqlite.query<ServerRow, []>("SELECT * FROM mail_servers ORDER BY created_at, id").all().map(serverFromRow);
  }

  getServer(id: string): StoredMailServer | null {
    const row = this.#sqlite.query<ServerRow, [string]>("SELECT * FROM mail_servers WHERE id = ?").get(id);
    return row ? serverFromRow(row) : null;
  }

  insertServer(server: StoredMailServer): void {
    this.#sqlite.query(`INSERT INTO mail_servers
      (id, name, base_url, credential_kind, encrypted_credential, mail_hostname, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(server.id, server.name, server.baseUrl, server.credentialKind,
      server.encryptedCredential, server.mailHostname, server.createdAt, server.updatedAt);
  }

  updateServer(server: StoredMailServer): void {
    this.#sqlite.query(`UPDATE mail_servers SET name = ?, credential_kind = ?, encrypted_credential = ?,
      mail_hostname = ?, updated_at = ? WHERE id = ?`).run(server.name, server.credentialKind,
      server.encryptedCredential, server.mailHostname, server.updatedAt, server.id);
  }

  deleteServer(id: string): void {
    this.#sqlite.transaction(() => {
      this.#sqlite.query("DELETE FROM mail_server_proposals WHERE server_id = ?").run(id);
      this.#sqlite.query("DELETE FROM mail_servers WHERE id = ?").run(id);
    })();
  }

  insertProposal(proposal: MailServerProposal): void {
    this.#sqlite.query(`INSERT INTO mail_server_proposals
      (id, server_id, title, created_by, operations, status, results, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(proposal.id, proposal.serverId, proposal.title, proposal.createdBy,
      JSON.stringify(proposal.operations), proposal.status, JSON.stringify(proposal.results), proposal.createdAt, proposal.decidedAt);
  }

  getProposal(id: string): MailServerProposal | null {
    const row = this.#sqlite.query<ProposalRow, [string]>("SELECT * FROM mail_server_proposals WHERE id = ?").get(id);
    return row ? proposalFromRow(row) : null;
  }

  listProposals(serverId?: string): MailServerProposal[] {
    const rows = serverId
      ? this.#sqlite.query<ProposalRow, [string]>("SELECT * FROM mail_server_proposals WHERE server_id = ? ORDER BY created_at DESC").all(serverId)
      : this.#sqlite.query<ProposalRow, []>("SELECT * FROM mail_server_proposals ORDER BY created_at DESC").all();
    return rows.map(proposalFromRow);
  }

  /** Moves a proposal from `from` to `status`; returns false when another request moved it first. */
  transitionProposal(
    id: string,
    from: MailServerProposal["status"],
    status: MailServerProposal["status"],
    results: MailServerProposal["results"],
    decidedAt: string | null,
  ): boolean {
    const changes = this.#sqlite.query(`UPDATE mail_server_proposals SET status = ?, results = ?, decided_at = ?
      WHERE id = ? AND status = ?`).run(status, JSON.stringify(results), decidedAt, id, from).changes;
    return changes === 1;
  }
}

