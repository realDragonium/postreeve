import { resolve } from "node:path";
import { createSnapshot, listSnapshots, restoreSnapshot, verifySnapshot } from "../src/server/runtime/backup";

const databasePath = resolve(process.env.POSTREEVE_DB_PATH ?? "./data/postreeve.sqlite");
const directory = resolve(process.env.POSTREEVE_BACKUP_DIR?.trim() || "./backups");
const keep = Number(process.env.POSTREEVE_BACKUP_KEEP ?? "7");
const [command = "create", argument] = process.argv.slice(2);

switch (command) {
  case "create": {
    const path = createSnapshot(databasePath, directory, keep);
    verifySnapshot(path);
    console.info(`Wrote and verified ${path}`);
    break;
  }
  case "list":
    for (const path of listSnapshots(directory)) console.info(path);
    break;
  case "verify":
    if (!argument) throw new Error("Usage: bun run backup verify <snapshot>");
    verifySnapshot(resolve(argument));
    console.info(`${resolve(argument)} is intact`);
    break;
  case "restore": {
    if (!argument) throw new Error("Usage: bun run backup restore <snapshot>   (stop Postreeve first)");
    const movedAside = restoreSnapshot(resolve(argument), databasePath);
    console.info(`Restored ${databasePath} from ${resolve(argument)}`);
    if (movedAside) console.info(`The previous database was kept at ${movedAside}`);
    break;
  }
  default:
    throw new Error("Usage: bun run backup [create | list | verify <snapshot> | restore <snapshot>]");
}
