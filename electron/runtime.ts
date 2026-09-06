import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const desktopEnvironmentKeys = [
  "POSTREEVE_DB_PATH",
  "POSTREEVE_GOOGLE_CLIENT_ID",
  "POSTREEVE_GOOGLE_CLIENT_SECRET",
  "POSTREEVE_MASTER_KEY",
  "POSTREEVE_MAX_ATTACHMENT_BYTES",
] as const;

export type DesktopEnvironment = Partial<Record<(typeof desktopEnvironmentKeys)[number], string>>;

export interface DesktopRuntimePathsInput {
  readonly appPath: string;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  readonly userDataPath: string;
}

export interface DesktopRuntimePaths {
  readonly databasePath: string;
  readonly rendererRoot: string;
  readonly serverPath: string;
  readonly workingDirectory: string;
}

export function parseDesktopEnvironment(source: string): DesktopEnvironment {
  const allowed = new Set<string>(desktopEnvironmentKeys);
  const parsed: DesktopEnvironment = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!allowed.has(key)) continue;
    const rawValue = line.slice(separator + 1).trim();
    const quoted = rawValue.match(/^(["'])(.*)\1$/);
    parsed[key as keyof DesktopEnvironment] = quoted?.[2] ?? rawValue;
  }

  return parsed;
}

export function readDevelopmentEnvironment(appPath: string): DesktopEnvironment {
  const environmentPath = resolve(appPath, ".env");
  return existsSync(environmentPath)
    ? parseDesktopEnvironment(readFileSync(environmentPath, "utf8"))
    : {};
}

export function desktopRuntimePaths(input: DesktopRuntimePathsInput): DesktopRuntimePaths {
  const executable = input.platform === "win32" ? "postreeve-server.exe" : "postreeve-server";
  return input.packaged ? {
    databasePath: resolve(input.userDataPath, "postreeve.sqlite"),
    rendererRoot: resolve(input.resourcesPath, "dist"),
    serverPath: resolve(input.resourcesPath, "server", executable),
    workingDirectory: input.resourcesPath,
  } : {
    databasePath: resolve(input.userDataPath, "postreeve.sqlite"),
    rendererRoot: resolve(input.appPath, "dist"),
    serverPath: resolve(input.appPath, "build", "server", executable),
    workingDirectory: input.appPath,
  };
}

export function configuredDatabasePath(
  configuredPath: string | undefined,
  appPath: string,
  fallbackPath: string,
): string {
  return configuredPath ? resolve(appPath, configuredPath) : fallbackPath;
}

export function resolveDesktopRendererPath(rendererRoot: string, pathname: string): string | undefined {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decodedPath.includes("\0")) return undefined;

  const root = resolve(rendererRoot);
  const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
  const candidate = resolve(root, relativePath);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : undefined;
}
