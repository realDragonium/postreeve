import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SNAPSHOT_PATTERN = /^postreeve-(\d{8}T\d{6}Z)\.sqlite$/;
const SIDECARS = ["", "-wal", "-shm"] as const;

export interface BackupPolicy {
  readonly directory: string;
  readonly intervalHours: number;
  readonly keep: number;
}

/** Reads the backup policy. Backups are off unless `POSTREEVE_BACKUP_DIR` names a directory. */
export function backupPolicyFromEnvironment(environment: Record<string, string | undefined>): BackupPolicy | undefined {
  const directory = environment.POSTREEVE_BACKUP_DIR?.trim();
  if (!directory) return undefined;
  const intervalHours = Number(environment.POSTREEVE_BACKUP_INTERVAL_HOURS ?? "24");
  const keep = Number(environment.POSTREEVE_BACKUP_KEEP ?? "7");
  if (!Number.isFinite(intervalHours) || intervalHours <= 0 || intervalHours > 24 * 31) {
    throw new Error("POSTREEVE_BACKUP_INTERVAL_HOURS must be a number of hours greater than 0 and at most 744");
  }
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) {
    throw new Error("POSTREEVE_BACKUP_KEEP must be an integer from 1 to 1000");
  }
  return { directory: resolve(directory), intervalHours, keep };
}

export function listSnapshots(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => SNAPSHOT_PATTERN.test(name)).sort().map(name => join(directory, name));
}

/**
 * Writes a consistent copy of the database with `VACUUM INTO` through a separate read-only connection, so it is safe
 * while the server is writing. The copy is written under a temporary name and renamed once complete, then the
 * oldest snapshots beyond `keep` are deleted.
 */
export function createSnapshot(databasePath: string, directory: string, keep: number, now = new Date()): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const target = join(directory, `postreeve-${stamp}.sqlite`);
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  const source = new Database(databasePath, { readonly: true });
  try {
    source.run("VACUUM INTO ?", [partial]);
  } finally {
    source.close();
  }
  chmodSync(partial, 0o600);
  renameSync(partial, target);
  for (const old of listSnapshots(directory).slice(0, -keep)) rmSync(old, { force: true });
  return target;
}

export function verifySnapshot(path: string): void {
  const database = new Database(path, { readonly: true });
  try {
    const result = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0]?.integrity_check !== "ok") {
      throw new Error(`Snapshot ${path} failed its integrity check`);
    }
    database.query("SELECT count(*) FROM accounts").get();
  } finally {
    database.close();
  }
}

/**
 * Replaces the database with a verified snapshot. The current database and its WAL files are moved aside to
 * `<db>.pre-restore-<stamp>` rather than deleted. The server must be stopped first.
 */
export function restoreSnapshot(snapshotPath: string, databasePath: string, now = new Date()): string | undefined {
  verifySnapshot(snapshotPath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  let movedAside: string | undefined;
  if (existsSync(databasePath)) {
    movedAside = `${databasePath}.pre-restore-${stamp}`;
    for (const suffix of SIDECARS) {
      if (existsSync(`${databasePath}${suffix}`)) renameSync(`${databasePath}${suffix}`, `${movedAside}${suffix}`);
    }
  }
  const staged = `${databasePath}.restoring`;
  const copy = new Database(snapshotPath, { readonly: true });
  try {
    rmSync(staged, { force: true });
    copy.run("VACUUM INTO ?", [staged]);
  } finally {
    copy.close();
  }
  chmodSync(staged, 0o600);
  renameSync(staged, databasePath);
  return movedAside;
}

/** Takes a snapshot when the newest one is older than the interval, now and then hourly. Returns a stop function. */
export function scheduleBackups(
  databasePath: string,
  policy: BackupPolicy,
  log: (message: string) => void,
  clock: () => Date = () => new Date(),
): () => void {
  const check = () => {
    const newest = listSnapshots(policy.directory).at(-1);
    const age = newest ? clock().getTime() - statSync(newest).mtimeMs : Number.POSITIVE_INFINITY;
    if (age < policy.intervalHours * 3_600_000) return;
    try {
      const path = createSnapshot(databasePath, policy.directory, policy.keep, clock());
      log(`Postreeve backup written to ${path}`);
    } catch (error) {
      log(`Postreeve backup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  };
  check();
  const timer = setInterval(check, Math.min(3_600_000, policy.intervalHours * 3_600_000));
  timer.unref();
  return () => clearInterval(timer);
}
