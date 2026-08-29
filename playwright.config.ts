import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4187",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "bun run dev:web --host 127.0.0.1 --port 4187",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
