import { describe, expect, test } from "bun:test";
import {
  configuredDatabasePath,
  desktopRuntimePaths,
  parseDesktopEnvironment,
  resolveDesktopRendererPath,
} from "../electron/runtime";

describe("Electron runtime", () => {
  test("reads only supported values from a local environment file", () => {
    expect(parseDesktopEnvironment([
      "# local settings",
      "POSTREEVE_MASTER_KEY='encoded=key'",
      "POSTREEVE_DB_PATH=./data/postreeve.sqlite",
      "POSTREEVE_MAX_ATTACHMENT_BYTES=1048576",
      "POSTREEVE_MAX_UPLOAD_BYTES=2000000",
      "POSTREEVE_MAX_MESSAGE_BYTES=3000000",
      "UNRELATED=value",
    ].join("\n"))).toEqual({
      POSTREEVE_MASTER_KEY: "encoded=key",
      POSTREEVE_DB_PATH: "./data/postreeve.sqlite",
      POSTREEVE_MAX_ATTACHMENT_BYTES: "1048576",
      POSTREEVE_MAX_UPLOAD_BYTES: "2000000",
      POSTREEVE_MAX_MESSAGE_BYTES: "3000000",
    });
  });

  test("uses bundled resources and the platform executable when packaged", () => {
    expect(desktopRuntimePaths({
      appPath: "/Applications/Postreeve.app/Contents/Resources/app.asar",
      packaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/Postreeve.app/Contents/Resources",
      userDataPath: "/Users/drago/Library/Application Support/Postreeve",
    })).toEqual({
      databasePath: "/Users/drago/Library/Application Support/Postreeve/postreeve.sqlite",
      rendererRoot: "/Applications/Postreeve.app/Contents/Resources/dist",
      serverPath: "/Applications/Postreeve.app/Contents/Resources/server/postreeve-server",
      workingDirectory: "/Applications/Postreeve.app/Contents/Resources",
    });
  });

  test("resolves a development database relative to the repository", () => {
    expect(configuredDatabasePath("./data/postreeve.sqlite", "/workspace/postreeve", "/fallback.sqlite"))
      .toBe("/workspace/postreeve/data/postreeve.sqlite");
  });

  test("keeps custom-protocol files inside the renderer bundle", () => {
    expect(resolveDesktopRendererPath("/app/dist", "/assets/main.js")).toBe("/app/dist/assets/main.js");
    expect(resolveDesktopRendererPath("/app/dist", "/")).toBe("/app/dist/index.html");
    expect(resolveDesktopRendererPath("/app/dist", "/../../secrets")).toBeUndefined();
    expect(resolveDesktopRendererPath("/app/dist", "/%E0%A4%A")).toBeUndefined();
  });
});
