import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, net, protocol, safeStorage, shell } from "electron";
import {
  configuredDatabasePath,
  desktopRuntimePaths,
  readDevelopmentEnvironment,
  resolveDesktopRendererPath,
  type DesktopEnvironment,
} from "./runtime";

const desktopScheme = "postreeve";
const desktopUrl = `${desktopScheme}://app/`;
const secureKeyPrefix = "safe-storage-v1\n";
const plainKeyPrefix = "plain-v1\n";
const startupTimeoutMs = 20_000;
const rendererContentSecurityPolicy = [
  "default-src 'self'",
  "img-src 'self' data: blob: http: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([{
  scheme: desktopScheme,
  privileges: {
    corsEnabled: true,
    secure: true,
    standard: true,
    supportFetchAPI: true,
  },
}]);

interface DesktopSession {
  readonly backendToken: string;
  readonly backendUrl: string;
  readonly rendererRoot: string;
}

let backend: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let desktopSession: DesktopSession | null = null;

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

async function waitForBackend(url: string, token: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Postreeve backend exited with code ${process.exitCode}`);
    try {
      const response = await fetch(new URL("api/health", url), {
        headers: { Authorization: `Bearer ${token}` },
      });
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

async function startBackend(): Promise<DesktopSession> {
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
  const backendToken = randomBytes(32).toString("base64url");
  const masterKey = environment.POSTREEVE_MASTER_KEY || desktopMasterKey(userDataPath);
  const databasePath = configuredDatabasePath(environment.POSTREEVE_DB_PATH, appPath, paths.databasePath);

  const spawnedBackend = spawn(paths.serverPath, [], {
    cwd: paths.workingDirectory,
    env: {
      ...environment,
      PORT: String(port),
      POSTREEVE_DB_PATH: databasePath,
      POSTREEVE_DESKTOP_TOKEN: backendToken,
      POSTREEVE_DESKTOP_URL: desktopUrl,
      POSTREEVE_HOST: "127.0.0.1",
      POSTREEVE_MASTER_KEY: masterKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  backend = spawnedBackend;
  await waitForBackend(url, backendToken, spawnedBackend);
  return { backendToken, backendUrl: url, rendererRoot: paths.rendererRoot };
}

async function proxyBackendRequest(request: Request, session: DesktopSession): Promise<Response> {
  const requestUrl = new URL(request.url);
  const backendUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, session.backendUrl);
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${session.backendToken}`);
  const methodHasBody = request.method !== "GET" && request.method !== "HEAD";
  const requestInit: RequestInit = {
    headers,
    method: request.method,
    redirect: "manual",
  };
  if (methodHasBody) requestInit.body = await request.arrayBuffer();
  return net.fetch(backendUrl.toString(), requestInit);
}

async function serveRenderer(requestUrl: URL, rendererRoot: string): Promise<Response> {
  const candidate = resolveDesktopRendererPath(rendererRoot, requestUrl.pathname);
  if (!candidate) return new Response("Not found", { status: 404 });

  const indexPath = join(rendererRoot, "index.html");
  const filePath = existsSync(candidate) && statSync(candidate).isFile() ? candidate : indexPath;
  if (!existsSync(filePath)) return new Response("Renderer bundle is missing", { status: 500 });

  const response = await net.fetch(pathToFileURL(filePath).toString());
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", rendererContentSecurityPolicy);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}

async function handleDesktopRequest(request: Request, session: DesktopSession): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== "app") return new Response("Not found", { status: 404 });
  return requestUrl.pathname.startsWith("/api/")
    ? proxyBackendRequest(request, session)
    : serveRenderer(requestUrl, session.rendererRoot);
}

async function createWindow(): Promise<void> {
  if (!desktopSession) throw new Error("Postreeve desktop has not finished starting");
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
  await mainWindow.loadURL(desktopUrl);
}

async function initializeDesktop(): Promise<void> {
  const session = await startBackend();
  desktopSession = session;
  protocol.handle(desktopScheme, (request) => handleDesktopRequest(request, session));
  await createWindow();
}

function stopBackend(): void {
  if (backend?.exitCode === null) backend.kill();
  backend = null;
  desktopSession = null;
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
  void app.whenReady().then(initializeDesktop).catch(showStartupError);
}
