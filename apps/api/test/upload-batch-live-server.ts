// Separate test entry: production server.ts and its Provider selection stay unchanged.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createRuntime, loadEnv, runStartupChecks } from "@liyoxi/services";
import type { Env, RuntimeOptions } from "@liyoxi/services";
import { createProviderHarness } from "@liyoxi/services/testing";
import { createApp } from "../src/app.js";
import { HANDLERS } from "../src/routes/index.js";
import { createOutputBatchCosStorage } from "./upload-batch-live-cos.js";

function assertScope(env: Env, prefix: string) {
  const database = new URL(env.DATABASE_URL),
    redis = new URL(env.REDIS_URL);
  const runId = /^lyx_test_admin_live_([a-f0-9]{16})$/.exec(database.pathname.slice(1))?.[1];
  if (
    env.APP_ENV !== "test" ||
    !runId ||
    prefix !== `lyx:test:admin_live_${runId}:` ||
    ![database, redis].every((url) => ["127.0.0.1", "localhost"].includes(url.hostname)) ||
    database.searchParams.get("options") !== "-c role=lyx_app"
  )
    throw new Error("W302 live requires the exact owned local test database and Redis prefix");
}

export async function startOutputBatchLiveServer(options: {
  env: Env;
  prefix: string;
  /** Root supplies the actually landed W304 tool boundary; no ready/check fixture writes. */
  configureRuntime?: (options: RuntimeOptions) => RuntimeOptions;
}) {
  assertScope(options.env, options.prefix);
  const base: RuntimeOptions = {
    entry: "api",
    env: options.env,
    version: "w302-private-live",
    redisKeyPrefix: options.prefix,
  };
  const realOwner = createRuntime(base);
  const harness = createProviderHarness();
  const cos = createOutputBatchCosStorage({
    real: realOwner.providers.storage,
    fake: harness.providers.storage,
    now: () => realOwner.clock.now(),
  });
  const configured = { ...base, providers: { ...harness.providers, storage: cos.storage } };
  let runtime: ReturnType<typeof createRuntime>;
  try {
    runtime = createRuntime(options.configureRuntime?.(configured) ?? configured);
  } catch (error) {
    cos.close();
    await realOwner.close();
    throw error;
  }
  const api = createApp({ runtime, handlers: HANDLERS });
  let apiServer: ReturnType<typeof serve> | undefined;
  let cosServer: ReturnType<typeof serve> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      api.readiness.state = "draining";
      if (interval) clearInterval(interval);
      await pending;
      for (const server of [apiServer, cosServer])
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      cos.close();
      const result = await Promise.allSettled([runtime.close(), realOwner.close()]);
      if (result.some((r) => r.status === "rejected"))
        throw new Error("W302 live resources did not fully close");
    })());
  try {
    await runStartupChecks(runtime.startupChecks);
    const apiOrigin = await new Promise<string>((resolve) => {
      apiServer = serve({ fetch: api.app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) =>
        resolve(`http://127.0.0.1:${port}`),
      );
    });
    const cosOrigin = await new Promise<string>((resolve) => {
      cosServer = serve(
        { fetch: (request) => cos.fetch(request), hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(`http://127.0.0.1:${port}`),
      );
    });
    api.readiness.state = "ready";
    // Invoke the real registered runner, at the worker's original 15 second scan cadence.
    interval = setInterval(() => {
      if (pending) return;
      pending = runtime.media
        .scanPromote()
        .then(() => undefined)
        .catch((error: unknown) =>
          runtime.logger.error(
            { evt: "w302.media.scan", errorType: error instanceof Error ? error.name : "unknown" },
            "媒体扫描失败",
          ),
        )
        .finally(() => {
          pending = undefined;
        });
    }, 15_000);
    return { apiOrigin, cosOrigin, runtime, harness, cos, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: { "test-redis-prefix": { type: "string" } } });
  if (!values["test-redis-prefix"]) throw new Error("Missing owned Redis prefix");
  const server = await startOutputBatchLiveServer({
    env: loadEnv(),
    prefix: values["test-redis-prefix"],
  });
  process.stdout.write(
    `${JSON.stringify({ evt: "w302.live.listening", apiOrigin: server.apiOrigin, cosOrigin: server.cosOrigin })}\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("W302 private live server failed\n");
    process.exitCode = 1;
  });
