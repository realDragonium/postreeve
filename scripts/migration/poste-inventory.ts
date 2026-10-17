/**
 * Reads domains and mailboxes from a poste.io admin API (GET requests only) and writes:
 *   inventory.json  what exists on poste.io
 *   plan.json       a Postreeve mail server proposal recreating it on Stalwart, plus manual steps
 *
 *   POSTE_PASSWORD=... bun scripts/migration/poste-inventory.ts --url https://old-mail.example.org --user admin@example.org \
 *     [--quota-unit mb|bytes] [--add-to-postreeve alice@example.org,bob@example.org] [--out ./migration]
 *   bun scripts/migration/poste-inventory.ts --from inventory.json [--out ./migration]   # a hand-written inventory
 *
 * It never changes poste.io. Check the field names against https://<poste-host>/admin/api/doc first.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inventoryFromPoste, planFromInventory, type Inventory } from "./plan";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const out = option("--out") ?? "./migration";
const addToPostreeve = (option("--add-to-postreeve") ?? "").split(",").filter(Boolean);

async function fetchAll(base: string, path: string, auth: string): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page < 1000; page += 1) {
    const response = await fetch(`${base}/admin/api/v1/${path}?page=${page}&paging=100`, { headers: { Authorization: auth, Accept: "application/json" } });
    if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
    const body = await response.json() as unknown;
    const results = Array.isArray(body) ? body : (body as { results?: unknown[] }).results ?? [];
    items.push(...results);
    const lastPage = Number((body as { last_page?: number }).last_page ?? page);
    if (Array.isArray(body) || results.length === 0 || page >= lastPage) return items;
  }
  return items;
}

let inventory: Inventory;
const from = option("--from");
if (from) {
  inventory = JSON.parse(readFileSync(from, "utf8")) as Inventory;
} else {
  const url = option("--url")?.replace(/\/+$/, "");
  const user = option("--user");
  const password = process.env.POSTE_PASSWORD;
  if (!url || !user || !password) {
    console.error("Give --url and --user, and the admin password in POSTE_PASSWORD (not on the command line).");
    process.exit(1);
  }
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const [domains, boxes] = await Promise.all([fetchAll(url, "domains", auth), fetchAll(url, "boxes", auth)]);
  inventory = inventoryFromPoste(domains, boxes, option("--quota-unit") === "bytes" ? "bytes" : "mb");
}

const plan = planFromInventory(inventory, { addToPostreeve });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
console.info(`${inventory.domains.length} domains, ${inventory.mailboxes.length} boxes -> ${plan.operations.length} operations in ${join(out, "plan.json")}`);
for (const line of plan.manual) console.info(`manual: ${line}`);
