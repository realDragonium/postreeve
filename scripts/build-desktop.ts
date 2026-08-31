import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

async function run(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], { stdout: "inherit", stderr: "inherit", env: Bun.env });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with code ${exitCode}`);
}

const serverExecutable = process.platform === "win32" ? "postreeve-server.exe" : "postreeve-server";
const serverOutput = resolve("build", "server", serverExecutable);
const electronOutput = resolve("build", "electron", "main.cjs");

mkdirSync(dirname(serverOutput), { recursive: true });
mkdirSync(dirname(electronOutput), { recursive: true });

await run(["bun", "run", "build"]);
await run(["bun", "build", "--compile", "src/server/index.ts", "--outfile", serverOutput]);
await run(["bun", "build", "--target=node", "--format=cjs", "--packages=external", `--outfile=${electronOutput}`, "electron/main.ts"]);

if (process.platform !== "win32") chmodSync(serverOutput, 0o755);
