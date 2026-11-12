import { serve } from "@hono/node-server";
import { loadConfig, ConfigError } from "./config.ts";
import { createFakeProvider, createRealProvider } from "./provider.ts";
import { createProbe } from "./app.ts";
import { Redactor, fileRecorder } from "./records.ts";
try {
  const config = loadConfig(process.env);
  const redactor = new Redactor();
  const provider =
    config.mode === "fake" ? createFakeProvider() : createRealProvider(config.secrets!);
  const app = createProbe(config, provider, fileRecorder(config.mode, redactor), redactor);
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: config.port });
  process.once("SIGTERM", () => server.close());
  process.once("SIGINT", () => server.close());
  server.on("error", () => {
    console.error("PROBE_LISTEN_FAILED");
    process.exitCode = 1;
  });
  console.log(
    `模式=${config.mode}；微信=${config.mode === "real" ? "已配置" : "未配置（替身）"}；对象存储=${config.mode === "real" ? "已配置" : "未配置（替身）"}`,
  );
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "PROBE_STARTUP");
  process.exitCode = 1;
}
