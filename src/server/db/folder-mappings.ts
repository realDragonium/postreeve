import type { Database } from "bun:sqlite";
import { folderMappingsSchema, specialFolderRoles, type FolderMappings, type SpecialFolderRole } from "../../shared/contracts";

const schemaVersion = 481001;

/** Creates `folder_mappings`: one row per overridden role, where a NULL path means the account has no such folder. */
export function migrateFolderMappings(sqlite: Database): void {
  if (sqlite.query("SELECT 1 FROM schema_migrations WHERE version = ?").get(schemaVersion)) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE folder_mappings (
        tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        role TEXT NOT NULL CHECK (role IN (${specialFolderRoles.map((role) => `'${role}'`).join(", ")})),
        path TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, account_id, role)
      );
    `);
    sqlite.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)").run(schemaVersion);
  }).immediate();
}

export function readFolderMappings(sqlite: Database, tenantId: string, accountId: string): FolderMappings {
  const rows = sqlite.query("SELECT role, path FROM folder_mappings WHERE tenant_id = ? AND account_id = ?")
    .all(tenantId, accountId) as Array<{ role: SpecialFolderRole; path: string | null }>;
  return folderMappingsSchema.parse(Object.fromEntries(rows.map(({ role, path }) => [role, path])));
}

/** Replaces every override of the account; roles absent from `mappings` return to automatic detection. */
export function replaceFolderMappings(
  sqlite: Database,
  tenantId: string,
  accountId: string,
  mappings: FolderMappings,
  updatedAt: string,
): void {
  sqlite.transaction(() => {
    sqlite.query("DELETE FROM folder_mappings WHERE tenant_id = ? AND account_id = ?").run(tenantId, accountId);
    const insert = sqlite.query(`
      INSERT INTO folder_mappings (tenant_id, account_id, role, path, updated_at) VALUES (?, ?, ?, ?, ?)
    `);
    for (const role of specialFolderRoles) {
      const path = mappings[role];
      if (path !== undefined) insert.run(tenantId, accountId, role, path, updatedAt);
    }
  }).immediate();
}
