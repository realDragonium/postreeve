import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApi } from "../src/server/api";
import { Store } from "../src/server/db/store";
import { GoogleOAuth, googleRedirectUri, type OAuthFetch } from "../src/server/google/oauth";
import {
  backupPolicyFromEnvironment,
  createSnapshot,
  listSnapshots,
  restoreSnapshot,
  scheduleBackups,
  verifySnapshot,
} from "../src/server/runtime/backup";
import { createShutdown } from "../src/server/runtime/shutdown";
import { createEmptyTestHarness } from "./support/test-mail";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "postreeve-self-host-"));
}

function seededDatabase(directory: string, marker: string): string {
  const path = join(directory, "data", "postreeve.sqlite");
  new Store(path).close();
  const database = new Database(path);
  database.exec("CREATE TABLE IF NOT EXISTS marker (value TEXT); DELETE FROM marker;");
  database.run("INSERT INTO marker VALUES (?)", [marker]);
  database.close();
  return path;
}

function marker(path: string): string | undefined {
  const database = new Database(path, { readonly: true });
  try {
    return database.query<{ value: string }, []>("SELECT value FROM marker").get()?.value;
  } finally {
    database.close();
  }
}

describe("Google redirect URI", () => {
  test("uses the loopback callback without a public URL", () => {
    expect(googleRedirectUri({}, 3000)).toBe("http://127.0.0.1:3000/api/oauth/google/callback");
    expect(googleRedirectUri({ POSTREEVE_PUBLIC_URL: "  " }, 4100)).toBe("http://127.0.0.1:4100/api/oauth/google/callback");
  });

  test("uses the public origin when one is configured", () => {
    expect(googleRedirectUri({ POSTREEVE_PUBLIC_URL: "https://mail-box.example-tailnet.ts.net/" }, 3000))
      .toBe("https://mail-box.example-tailnet.ts.net/api/oauth/google/callback");
  });

  test("keeps the loopback callback when asked to", () => {
    expect(googleRedirectUri({
      POSTREEVE_PUBLIC_URL: "https://mail-box.example-tailnet.ts.net",
      POSTREEVE_GOOGLE_REDIRECT: "loopback",
    }, 3000)).toBe("http://127.0.0.1:3000/api/oauth/google/callback");
  });

  test("rejects public URLs Google or the server cannot use", () => {
    expect(() => googleRedirectUri({ POSTREEVE_PUBLIC_URL: "http://mail.example.test" }, 3000)).toThrow("https://");
    expect(() => googleRedirectUri({ POSTREEVE_PUBLIC_URL: "https://mail.example.test/postreeve" }, 3000))
      .toThrow("without a path");
    expect(() => googleRedirectUri({ POSTREEVE_PUBLIC_URL: "not a url" }, 3000)).toThrow("https://");
    expect(() => googleRedirectUri({ POSTREEVE_GOOGLE_REDIRECT: "public" }, 3000)).toThrow("requires POSTREEVE_PUBLIC_URL");
    expect(() => googleRedirectUri({ POSTREEVE_GOOGLE_REDIRECT: "tunnel" }, 3000)).toThrow("public or loopback");
  });

  test("runs the state-bound PKCE flow against the hosted callback", async () => {
    const redirectUri = googleRedirectUri({ POSTREEVE_PUBLIC_URL: "https://mail-box.example-tailnet.ts.net" }, 3000);
    const tokenBodies: URLSearchParams[] = [];
    const request: OAuthFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        tokenBodies.push(new URLSearchParams(init?.body?.toString() ?? ""));
        return Response.json({ access_token: "access", refresh_token: "refresh" });
      }
      return Response.json({ emailAddress: "person@example.test" });
    };
    const oauth = new GoogleOAuth("web-client-id", redirectUri, request, "web-client-secret");
    const authorizationUrl = new URL(oauth.start());
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorizationUrl.searchParams.get("state");
    const callback = `${redirectUri}?code=test-code&state=${state}`;
    expect(await oauth.complete(callback)).toEqual({ email: "person@example.test", refreshToken: "refresh" });
    expect(tokenBodies[0]?.get("redirect_uri")).toBe(redirectUri);
    expect(tokenBodies[0]?.get("client_secret")).toBe("web-client-secret");
    expect(tokenBodies[0]?.get("code_verifier")).toBeTruthy();
    expect(oauth.complete(callback)).rejects.toThrow("missing or expired");
  });
});

describe("graceful shutdown", () => {
  test("drains requests and synchronization before closing the store, once", async () => {
    const steps: string[] = [];
    let finishSync = () => undefined as void;
    const shutdown = createShutdown({
      server: { stop: async (force) => { steps.push(force ? "force-stop" : "stop-accepting"); } },
      endStreams: () => steps.push("end-streams"),
      stopSynchronization: () => new Promise<void>(resolve => {
        steps.push("stop-sync");
        finishSync = () => { steps.push("sync-finished"); resolve(); };
      }),
      closeStore: () => steps.push("close-store"),
      drainTimeoutMs: 5_000,
    });
    const first = shutdown();
    expect(shutdown()).toBe(first);
    await Bun.sleep(5);
    expect(steps).toEqual(["stop-accepting", "end-streams", "stop-sync"]);
    finishSync();
    await first;
    expect(steps).toEqual(["stop-accepting", "end-streams", "stop-sync", "sync-finished", "close-store"]);
  });

  test("closes remaining connections after the drain timeout", async () => {
    const steps: string[] = [];
    const logs: string[] = [];
    await createShutdown({
      server: { stop: (force) => { steps.push(force ? "force-stop" : "stop-accepting"); return force ? undefined : new Promise<void>(() => undefined); } },
      endStreams: () => undefined,
      stopSynchronization: async () => undefined,
      closeStore: () => steps.push("close-store"),
      drainTimeoutMs: 10,
      log: message => logs.push(message),
    })();
    expect(steps).toEqual(["stop-accepting", "force-stop", "close-store"]);
    expect(logs.some(message => message.includes("did not finish within 10 ms"))).toBe(true);
  });

  test("ends open mailbox event streams when shutdown starts", async () => {
    const { service, store } = await createEmptyTestHarness();
    const controller = new AbortController();
    const response = await createApi(service, undefined, { shutdownSignal: controller.signal }).request("/api/events");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
    controller.abort();
    expect((await reader.read()).done).toBe(true);
    store.close();
  });
});

describe("local backups", () => {
  test("are off unless a directory is configured and validate their limits", () => {
    expect(backupPolicyFromEnvironment({})).toBeUndefined();
    expect(backupPolicyFromEnvironment({ POSTREEVE_BACKUP_DIR: "/srv/backups" }))
      .toEqual({ directory: "/srv/backups", intervalHours: 24, keep: 7 });
    expect(() => backupPolicyFromEnvironment({ POSTREEVE_BACKUP_DIR: "b", POSTREEVE_BACKUP_KEEP: "0" })).toThrow("KEEP");
    expect(() => backupPolicyFromEnvironment({ POSTREEVE_BACKUP_DIR: "b", POSTREEVE_BACKUP_INTERVAL_HOURS: "x" }))
      .toThrow("INTERVAL");
  });

  test("snapshots a live database, rotates old snapshots and restores one", () => {
    const directory = temporaryDirectory();
    const databasePath = seededDatabase(directory, "first");
    const backups = join(directory, "backups");
    const writer = new Database(databasePath);
    const oldest = createSnapshot(databasePath, backups, 2, new Date("2026-10-01T00:00:00Z"));
    writer.run("UPDATE marker SET value = ?", ["second"]);
    const middle = createSnapshot(databasePath, backups, 2, new Date("2026-10-02T00:00:00Z"));
    writer.run("UPDATE marker SET value = ?", ["third"]);
    const newest = createSnapshot(databasePath, backups, 2, new Date("2026-10-03T00:00:00Z"));
    writer.close();

    expect(listSnapshots(backups)).toEqual([middle, newest]);
    expect(existsSync(oldest)).toBe(false);
    expect(newest).toEndWith("postreeve-20261003T000000Z.sqlite");
    verifySnapshot(middle);

    const movedAside = restoreSnapshot(middle, databasePath, new Date("2026-10-04T00:00:00Z"));
    expect(marker(databasePath)).toBe("second");
    expect(movedAside).toBe(`${databasePath}.pre-restore-20261004T000000Z`);
    expect(marker(movedAside!)).toBe("third");
    new Store(databasePath).close();
  });

  test("refuses to restore a file that is not a Postreeve database", () => {
    const directory = temporaryDirectory();
    const databasePath = seededDatabase(directory, "kept");
    const bogus = join(directory, "bogus.sqlite");
    writeFileSync(bogus, "not a database");
    expect(() => restoreSnapshot(bogus, databasePath)).toThrow();
    const empty = join(directory, "empty.sqlite");
    new Database(empty).close();
    expect(() => restoreSnapshot(empty, databasePath)).toThrow();
    expect(marker(databasePath)).toBe("kept");
  });

  test("the schedule writes a snapshot only when the newest one is due", () => {
    const directory = temporaryDirectory();
    const databasePath = seededDatabase(directory, "scheduled");
    const policy = { directory: join(directory, "backups"), intervalHours: 24, keep: 3 };
    const logs: string[] = [];
    scheduleBackups(databasePath, policy, message => logs.push(message))();
    expect(listSnapshots(policy.directory)).toHaveLength(1);
    scheduleBackups(databasePath, policy, message => logs.push(message), () => new Date(Date.now() + 60_000))();
    expect(listSnapshots(policy.directory)).toHaveLength(1);
    const [snapshot] = listSnapshots(policy.directory);
    const stale = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(snapshot!, stale, stale);
    scheduleBackups(databasePath, policy, message => logs.push(message), () => new Date(Date.now() + 1_000))();
    expect(listSnapshots(policy.directory)).toHaveLength(2);
    expect(logs.filter(message => message.startsWith("Postreeve backup written"))).toHaveLength(2);
  });
});

describe("container entrypoint", () => {
  const entrypoint = resolve("deploy/docker-entrypoint.sh");

  function stubs(uid: string): { bin: string; log: string } {
    const bin = temporaryDirectory();
    const log = join(bin, "calls.log");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("id", `if [ "$2" = "bun" ]; then echo 1000; else echo ${uid}; fi`);
    stub("stat", "echo 0");
    stub("mkdir", `echo "mkdir $*" >> ${log}`);
    stub("chown", `echo "chown $*" >> ${log}`);
    stub("setpriv", `echo "setpriv $*" >> ${log}`);
    stub("server", `echo "server $*" >> ${log}`);
    return { bin, log };
  }

  function run(uid: string, environment: Record<string, string>): string {
    const { bin, log } = stubs(uid);
    const result = Bun.spawnSync(["/bin/sh", entrypoint, "server", "--flag"], {
      env: { PATH: `${bin}:/usr/bin:/bin`, ...environment },
    });
    expect(result.exitCode).toBe(0);
    return readFileSync(log, "utf8");
  }

  test("as root it hands the data and backup directories to bun, then drops privileges", () => {
    const calls = run("0", { POSTREEVE_DB_PATH: "/app/data/postreeve.sqlite", POSTREEVE_BACKUP_DIR: "/app/backups" });
    expect(calls).toBe([
      "mkdir -p /app/data",
      "chown -R bun:bun /app/data",
      "mkdir -p /app/backups",
      "chown -R bun:bun /app/backups",
      "setpriv --reuid=bun --regid=bun --init-groups -- server --flag",
      "",
    ].join("\n"));
  });

  test("as an unprivileged user it runs the command directly", () => {
    expect(run("1000", {})).toBe("server --flag\n");
  });
});
