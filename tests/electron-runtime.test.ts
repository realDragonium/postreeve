import { describe, expect, test } from "bun:test";
import {
  configuredDatabasePath,
  desktopRuntimePaths,
  parseDesktopEnvironment,
} from "../electron/runtime";

describe("Electron runtime", () => {
  test("reads only supported values from a local environment file", () => {
    expect(parseDesktopEnvironment([
      "# local settings",
      "POSTREEVE_MASTER_KEY='encoded=key'",
      "POSTREEVE_DB_PATH=./data/postreeve.sqlite",
      "UNRELATED=value",
    ].join("\n"))).toEqual({
      POSTREEVE_MASTER_KEY: "encoded=key",
      POSTREEVE_DB_PATH: "./data/postreeve.sqlite",
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
      serverPath: "/Applications/Postreeve.app/Contents/Resources/server/postreeve-server",
      workingDirectory: "/Applications/Postreeve.app/Contents/Resources",
    });
  });

  test("resolves a development database relative to the repository", () => {
    expect(configuredDatabasePath("./data/postreeve.sqlite", "/workspace/postreeve", "/fallback.sqlite"))
      .toBe("/workspace/postreeve/data/postreeve.sqlite");
  });
});
