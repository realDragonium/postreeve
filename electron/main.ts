import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import {
  configuredDatabasePath,
  desktopRuntimePaths,
  readDevelopmentEnvironment,
  type DesktopEnvironment,
} from "./runtime";

const secureKeyPrefix = "safe-storage-v1\n";
const plainKeyPrefix = "plain-v1\n";
const startupTimeoutMs = 20_000;

let backend: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let appUrl: string | null = null;

function desktopMasterKey(userDataPath: string): string {
  const keyPath = join(userDataPath, "master-key");
  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath);
    const securePrefix = Buffer.from(secureKeyPrefix);
    const plainPrefix = Buffer.from(plainKeyPrefix);
    if (stored.subarray(0, securePrefix.length).equals(securePrefix)) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system secure storage is unavailable");
      return safeStorage.decryptString(stored.subarray(securePrefix.length));
    }
    if (stored.subarray(0, plainPrefix.length).equals(plainPrefix)) {
      return stored.subarray(plainPrefix.length).toString("utf8").trim();
    }
    throw new Error("The desktop encryption key has an unsupported format");
  }

  const key = randomBytes(32).toString("base64");
  mkdirSync(userDataPath, { recursive: true });
  const stored = safeStorage.isEncryptionAvailable()
    ? Buffer.concat([Buffer.from(secureKeyPrefix), safeStorage.encryptString(key)])
    : Buffer.from(`${plainKeyPrefix}${key}\n`);
  writeFileSync(keyPath, stored, { flag: "wx", mode: 0o600 });
  return key;
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForBackend(url: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Postreeve backend exited with code ${process.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The sidecar has not bound its port yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Postreeve backend did not become ready in time");
}

function mergedEnvironment(local: DesktopEnvironment): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(local).filter(([, value]) => value !== undefined)),
    ...process.env,
  };
}

async function startBackend(): Promise<string> {
  const appPath = app.getAppPath();
  const userDataPath = app.getPath("userData");
  const paths = desktopRuntimePaths({
    appPath,
    packaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    userDataPath,
  });
  if (!existsSync(paths.serverPath)) throw new Error(`Missing desktop backend at ${paths.serverPath}`);

  const localEnvironment = app.isPackaged ? {} : readDevelopmentEnvironment(appPath);
  const environment = mergedEnvironment(localEnvironment);
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  const masterKey = environment.POSTREEVE_MASTER_KEY || desktopMasterKey(userDataPath);
  const databasePath = configuredDatabasePath(environment.POSTREEVE_DB_PATH, appPath, paths.databasePath);

  const spawnedBackend = spawn(paths.serverPath, [], {
    cwd: paths.workingDirectory,
    env: {
      ...environment,
      PORT: String(port),
      POSTREEVE_DB_PATH: databasePath,
      POSTREEVE_HOST: "127.0.0.1",
      POSTREEVE_MASTER_KEY: masterKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  backend = spawnedBackend;
  await waitForBackend(url, spawnedBackend);
  return url;
}

async function createWindow(): Promise<void> {
  if (!appUrl) appUrl = await startBackend();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Postreeve",
    backgroundColor: "#151413",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadURL(appUrl);
}

function stopBackend(): void {
  if (!backend || backend.exitCode !== null) return;
  backend.kill();
  backend = null;
}

function showStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("Postreeve could not start", message);
  stopBackend();
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("before-quit", stopBackend);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!mainWindow) void createWindow().catch(showStartupError);
  });
  void app.whenReady().then(createWindow).catch(showStartupError);
}
