import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const channel = process.env.LYX_E2E_CHANNEL;
if (channel && channel !== "chrome") throw new Error("MIGRATION_BROWSER_CHANNEL_INVALID");

/** UI-only contract smoke. The production build has no fixture entry or authentication bridge. */
export default defineConfig({
  testDir: "./test/migration",
  testMatch: "*.spec.ts",
  outputDir: "./dist/e2e-migration",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    channel,
    baseURL: "http://127.0.0.1:5194",
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 5194 --strictPort",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    url: "http://127.0.0.1:5194",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
