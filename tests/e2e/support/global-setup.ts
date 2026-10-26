import { execFileSync } from "node:child_process";

/**
 * Builds the production bundle once, before any worker starts. Specs that run a real server serve `./dist`, and
 * `vite build` empties it first, so a spec that rebuilt it would break another worker's server mid-test.
 */
export default function globalSetup(): void {
  execFileSync("bun", ["run", "build"], { stdio: ["ignore", "ignore", "inherit"] });
}
