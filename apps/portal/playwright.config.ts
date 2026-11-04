import { defineConfig, devices } from "@playwright/test";
import { dirname, join } from "node:path";
import { liveContext } from "./test/e2e/control-client";

const context = liveContext();
const channel = process.env.LYX_E2E_CHANNEL;
if (channel && channel !== "chrome") throw new Error("LIVE_BROWSER_CHANNEL_INVALID");

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: ["live-session.spec.ts", "preview-verify.spec.ts"],
  outputDir: join(dirname(context.stageDirectory), "playwright-private"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["./test/e2e/safe-reporter.ts"]],
  use: {
    ...devices["Desktop Chrome"],
    channel,
    baseURL: context.origin,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    screenshot: "off",
    launchOptions: { args: ["--host-resolver-rules=MAP portal.localhost 127.0.0.1"] },
  },
});
