/**
 * Writes a shell script that copies every mailbox in plan.json from poste.io to Stalwart with imapsync.
 * Read it, run it once as written (it is a dry run), then regenerate with --live to copy for real.
 *
 *   bun scripts/migration/imapsync-plan.ts --old old-mail.example.org --new mail.example.org \
 *     [--old-port 993] [--new-port 993] [--old-self-signed] [--new-self-signed] [--plan ./migration/plan.json] [--passwords ./migration/passwords] [--live] > migration/sync.sh
 */
import { readFileSync } from "node:fs";
import { imapsyncScript, type MigrationPlan } from "./plan";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const oldHost = option("--old");
const newHost = option("--new");
if (!oldHost || !newHost) {
  console.error("Give --old <poste.io IMAP host> and --new <Stalwart IMAP host>.");
  process.exit(1);
}
const plan = JSON.parse(readFileSync(option("--plan") ?? "./migration/plan.json", "utf8")) as MigrationPlan;
process.stdout.write(imapsyncScript(plan.copyMail, {
  oldHost, newHost, oldPort: Number(option("--old-port") ?? 993), newPort: Number(option("--new-port") ?? 993), newSelfSigned: args.includes("--new-self-signed"), oldSelfSigned: args.includes("--old-self-signed"), passwordDir: option("--passwords") ?? "./migration/passwords", dryRun: !args.includes("--live"),
}));
