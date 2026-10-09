// Task-private entry: real production handlers/middleware, no production server switch.
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createRuntime, loadEnv, runStartupChecks } from "@liyoxi/services";
import type { Env, RuntimeOptions } from "@liyoxi/services";
import {
  createProviderHarness,
  OutputBatchLiveInputSchema,
  findOutputBatchLiveJobIds,
  prepareOutputBatchLiveMasters,
} from "@liyoxi/services/testing";
import type { OutputBatchLiveInput } from "@liyoxi/services/testing";
import { createApp } from "../src/app.js";
import type { Api } from "../src/app.js";
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
  return runId;
}

export async function startOutputBatchLiveServer(options: {
  env: Env;
  prefix: string;
  inputs: OutputBatchLiveInput;
  /** Root binds the actually landed W304 public tool capability, not a ready-state fixture. */
  configureRuntime?: (options: RuntimeOptions, inputs: OutputBatchLiveInput) => RuntimeOptions;
}) {
  const runId = assertScope(options.env, options.prefix);
  const inputs = OutputBatchLiveInputSchema.parse(options.inputs);
  if (inputs.current.runId !== runId || inputs.legacy.runId !== runId)
    throw new Error("W302 input scope differs from the exact database");
  if (!options.configureRuntime)
    throw new Error("W302 actual W304 tool boundary has not been configured");
  const base: RuntimeOptions = {
    entry: "api",
    env: options.env,
    version: "w302-private-live",
    redisKeyPrefix: options.prefix,
  };
  const realOwner = createRuntime(base),
    harness = createProviderHarness();
  const cos = createOutputBatchCosStorage({
    real: realOwner.providers.storage,
    fake: harness.providers.storage,
    now: () => realOwner.clock.now(),
  });
  const borrowed = { ...base, providers: { ...harness.providers, storage: cos.storage } };
  const runtimes: ReturnType<typeof createRuntime>[] = [];
  const apis: Api[] = [];
  let apiServer: ReturnType<typeof serve> | undefined,
    cosServer: ReturnType<typeof serve> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined, pending: Promise<void> | undefined;
  let masters: Awaited<ReturnType<typeof prepareOutputBatchLiveMasters>> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      for (const api of apis) api.readiness.state = "draining";
      if (interval) clearInterval(interval);
      // Cancel executor IO before waiting for a pump which may itself be awaiting that IO.
      const jobResults = await Promise.allSettled(
        runtimes.map((runtime) => runtime.media.jobs.shutdown()),
      );
      await pending;
      const servers = [apiServer, cosServer].filter((server) => server !== undefined);
      const serverResults = await Promise.allSettled(
        servers.map(async (server) => {
          if ("closeAllConnections" in server) server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }),
      );
      const inputResults = await Promise.allSettled([masters?.cleanup()]);
      cos.close();
      const runtimeResults: PromiseSettledResult<void>[] = [];
      // Reverse construction order preserves the previously bound live scope until it closes.
      for (const runtime of [...[...runtimes].reverse(), realOwner])
        runtimeResults.push(...(await Promise.allSettled([runtime.close()])));
      if (
        [...jobResults, ...serverResults, ...inputResults, ...runtimeResults].some(
          (r) => r.status === "rejected",
        )
      )
        throw new Error("W302 live resources did not fully close");
    })());
  try {
    // Old single sample uses its actual M1 bridge, without W304 inspecting the 1s sample.
    const legacy = createRuntime(borrowed);
    runtimes.push(legacy);
    const batch = createRuntime(options.configureRuntime(borrowed, inputs));
    runtimes.push(batch);
    masters = await prepareOutputBatchLiveMasters(legacy, inputs);
    const legacyApi = createApp({ runtime: legacy, handlers: HANDLERS });
    apis.push(legacyApi);
    const batchApi = createApp({ runtime: batch, handlers: HANDLERS });
    apis.push(batchApi);
    await runStartupChecks(legacy.startupChecks);
    await runStartupChecks(batch.startupChecks);
    const apiOrigin = await new Promise<string>((resolve) => {
      apiServer = serve(
        {
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname;
            const api = /^\/api\/v1\/admin\/(?:upload-batches|upload-batch-items)(?:\/|$)/.test(
              path,
            )
              ? batchApi
              : legacyApi;
            return api.app.fetch(request);
          },
        },
        ({ port }) => resolve(`http://127.0.0.1:${port}`),
      );
    });
    const cosOrigin = await new Promise<string>((resolve) => {
      cosServer = serve(
        { fetch: (request) => cos.fetch(request), hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolve(`http://127.0.0.1:${port}`),
      );
    });
    for (const api of apis) api.readiness.state = "ready";
    // Original 15s cadence; exact owned IDs, never the all-database scanPromote.
    interval = setInterval(() => {
      if (pending) return;
      pending = findOutputBatchLiveJobIds(batch, inputs)
        .then(async (ids) => {
          for (let at = 0; at < ids.length; at += 2)
            await Promise.all(ids.slice(at, at + 2).map((jobId) => batch.media.promote({ jobId })));
        })
        .catch((error: unknown) =>
          batch.logger.error(
            { evt: "w302.media.pump", errorType: error instanceof Error ? error.name : "unknown" },
            "本轮批次任务执行失败",
          ),
        )
        .finally(() => {
          pending = undefined;
        });
    }, 15_000);
    return { apiOrigin, cosOrigin, runtime: legacy, batchRuntime: batch, harness, cos, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: { "test-redis-prefix": { type: "string" }, "input-manifest": { type: "string" } },
  });
  if (!values["test-redis-prefix"] || !values["input-manifest"])
    throw new Error("Missing owned Redis prefix or input manifest");
  const path = await realpath(values["input-manifest"]);
  const env = loadEnv(),
    runId = assertScope(env, values["test-redis-prefix"]);
  if (!path.includes(`/admin-live-${runId}/`) || !path.endsWith("/media-input.json"))
    throw new Error("Input manifest must be the exact owned temporary file");
  const inputs = OutputBatchLiveInputSchema.parse(JSON.parse(await readFile(path, "utf8")));
  // Actual W304 tool injection is supplied only after its implementation reaches main.
  const server = await startOutputBatchLiveServer({
    env,
    prefix: values["test-redis-prefix"],
    inputs,
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
