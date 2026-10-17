/**
 * Boots a throwaway Stalwart v0.16.26 on loopback high ports for the opt-in live test
 * (tests/stalwart-live.test.ts). Never point it at a real server: it creates its own empty data directory,
 * uses the reserved example.org domain and deletes everything when you stop it.
 *
 *   bun scripts/stalwart-test-instance.ts [--bin /path/to/stalwart] [--port 18080] [--keep]
 *
 * It prints the environment for the live test and keeps running until Ctrl-C.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const VERSION = "v0.16.26";
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const basePort = Number(option("--port") ?? 18080);
const keep = args.includes("--keep");
const ports = { http: basePort, imaps: basePort + 913, submissions: basePort + 385, smtp: basePort + 945, sieve: basePort + 110 };
const dir = mkdtempSync(join(tmpdir(), "postreeve-stalwart-"));
const config = join(dir, "config.json");
const recoveryPassword = randomBytes(12).toString("base64url");
const children: ReturnType<typeof Bun.spawn>[] = [];

async function binary(): Promise<string> {
  const given = option("--bin") ?? process.env.STALWART_BIN;
  if (given) return given;
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
  const url = `https://github.com/stalwartlabs/stalwart/releases/download/${VERSION}/stalwart-${arch}-${os}.tar.gz`;
  console.info(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const archive = join(dir, "stalwart.tar.gz");
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const untar = Bun.spawnSync(["tar", "-xzf", archive, "-C", dir]);
  if (untar.exitCode !== 0) throw new Error("Could not unpack the Stalwart archive");
  const path = join(dir, "stalwart");
  chmodSync(path, 0o755);
  return path;
}

function start(bin: string, env: Record<string, string>) {
  const child = Bun.spawn([bin, "--config", config], { env: { ...process.env, ...env }, stdout: Bun.file(join(dir, "stalwart.log")), stderr: "inherit" });
  children.push(child);
  return child;
}

async function jmap(auth: string, calls: unknown[]): Promise<Record<string, any>[]> {
  const response = await fetch(`http://127.0.0.1:${ports.http}/jmap/`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls: calls }),
  });
  if (!response.ok) throw new Error(`JMAP HTTP ${response.status}: ${await response.text()}`);
  return (await response.json() as { methodResponses: [string, Record<string, any>][] }).methodResponses.map(([name, body]) => {
    if (name === "error") throw new Error(`JMAP error: ${JSON.stringify(body)}`);
    return body;
  });
}

async function waitForHttp(auth: string) {
  let lastStatus = "no connection";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${ports.http}/jmap/session`, { headers: { Authorization: auth } });
      lastStatus = String(response.status);
      if (response.ok) return (await response.json() as { primaryAccounts: Record<string, string> }).primaryAccounts["urn:stalwart:jmap"]!;
    } catch { /* not listening yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`Stalwart did not answer on port ${ports.http} (last status ${lastStatus}); see the logs in ${dir}`);
}

async function stop(child: ReturnType<typeof Bun.spawn>) {
  child.kill("SIGTERM");
  await child.exited;
}

function cleanup() {
  for (const child of children) child.kill("SIGKILL");
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

try {
  const bin = await binary();
  const recovery = { STALWART_RECOVERY_ADMIN: `admin:${recoveryPassword}`, STALWART_RECOVERY_MODE_PORT: String(ports.http) };
  const recoveryAuth = `Basic ${Buffer.from(`admin:${recoveryPassword}`).toString("base64")}`;

  // 1. First start: bootstrap mode, only the setup listener is open.
  let child = start(bin, recovery);
  let accountId = await waitForHttp(recoveryAuth);
  const [bootstrap] = await jmap(recoveryAuth, [["x:Bootstrap/set", { accountId, update: { singleton: {
    serverHostname: "mail.example.org", defaultDomain: "example.org", requestTlsCertificate: false,
    dataStore: { "@type": "RocksDb", path: join(dir, "data") + "/" },
    tracer: { "@type": "Log", path: join(dir, "logs") + "/", prefix: "stalwart", rotate: "daily", ansi: false, multiline: false, enable: true, level: "info", lossy: false, events: {}, eventsPolicy: "exclude" },
  } } }, "0"]]);
  const admin = bootstrap!.updated.singleton as { username: string; secret: string };
  await Bun.sleep(1000);
  await stop(child);

  // 2. Recovery mode: create loopback listeners on high ports. Stalwart adds its default listeners
  //    (25, 443, 993, ...) only when none exist, so these replace them before anything binds.
  child = start(bin, { ...recovery, STALWART_RECOVERY_MODE: "1" });
  accountId = await waitForHttp(recoveryAuth);
  const listener = (name: string, protocol: string, port: number, tlsImplicit: boolean) =>
    ({ name, protocol, bind: { [`127.0.0.1:${port}`]: true }, useTls: true, tlsImplicit });
  const [created] = await jmap(recoveryAuth, [["x:NetworkListener/set", { accountId, create: {
    http: listener("http", "http", ports.http, false),
    smtp: listener("smtp", "smtp", ports.smtp, false),
    submissions: listener("submissions", "smtp", ports.submissions, true),
    imaps: listener("imaps", "imap", ports.imaps, true),
    sieve: listener("sieve", "manageSieve", ports.sieve, false),
  } }, "0"]]);
  if (created!.notCreated) throw new Error(`Could not create the listeners: ${JSON.stringify(created!.notCreated)}`);
  // Give the store a moment to persist before the restart.
  await Bun.sleep(1000);
  await stop(child);

  // 3. Normal start, then an API key for Postreeve.
  start(bin, {});
  const adminAuth = `Basic ${Buffer.from(`${admin.username}:${admin.secret}`).toString("base64")}`;
  accountId = await waitForHttp(adminAuth);
  const [key] = await jmap(adminAuth, [["x:ApiKey/set", { accountId, create: { k: { description: "Postreeve live test" } } }, "0"]]);
  const apiKey = key!.created.k.secret as string;
  writeFileSync(join(dir, "test.env"), [
    `POSTREEVE_STALWART_TEST_URL=http://127.0.0.1:${ports.http}`,
    `POSTREEVE_STALWART_TEST_KEY=${apiKey}`,
    `POSTREEVE_STALWART_TEST_IMAP_PORT=${ports.imaps}`,
    "",
  ].join("\n"), { mode: 0o600 });
  console.info(`Throwaway Stalwart ${VERSION} is running in ${dir} (deleted on exit${keep ? " unless --keep" : ""}).`);
  console.info(`Run the live test in another shell:\n  env $(cat ${join(dir, "test.env")} | xargs) bun test tests/stalwart-live.test.ts`);
  if (!existsSync(join(dir, "data"))) console.warn("Data directory missing; the bootstrap step may have failed.");
  await new Promise(() => undefined);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  cleanup();
  process.exit(1);
}
