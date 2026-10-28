import { assembleProductionMediaTools, guardProviderCall } from "../kernel/index.js";
import type { Env } from "../kernel/index.js";
import type { MediaProductionDeps } from "../media/index.js";
import type {
  Providers,
  ProductionMediaTools,
  MediaToolClient,
  MediaWorkspace,
  MediaWorkSession,
} from "../providers/types.js";
import { readStoreMediaFacts } from "../tenant/index.js";
import { readAdDurationFacts, readAdProductionKind } from "../delivery/index.js";
import {
  readMasterProductionFacts,
  readTrailerMediaFacts,
  setTrailerTarget,
  installTrailerCurrent,
} from "../content/index.js";

/** Test tools replace only external IO; the transaction guard and facts remain fixed. */
function guardedTestTools(raw: ProductionMediaTools): ProductionMediaTools {
  let closed = false,
    closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>(),
    active = new Set<AbortController>();
  const invoke = <T>(
    method: "probe" | "transcode",
    caller: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    guardProviderCall({ provider: "media", method });
    if (closed) return Promise.reject(new TypeError("媒体测试工具已关闭"));
    const controller = new AbortController(),
      abort = () => controller.abort();
    caller?.addEventListener("abort", abort, { once: true });
    if (caller?.aborted) abort();
    active.add(controller);
    const promise = Promise.resolve().then(() => action(controller.signal));
    pending.add(promise);
    return promise.finally(() => {
      caller?.removeEventListener("abort", abort);
      active.delete(controller);
      pending.delete(promise);
    });
  };
  const client: MediaToolClient = {
    probe: (input) =>
      invoke("probe", input.signal, (signal) => raw.client.probe({ ...input, signal })),
    poster: (input) =>
      invoke("probe", input.signal, (signal) => raw.client.poster({ ...input, signal })),
    stampAigc: (input) =>
      invoke("transcode", input.signal, (signal) => raw.client.stampAigc({ ...input, signal })),
    health: (signal) => invoke("probe", signal, (owned) => raw.client.health(owned)),
    ...(raw.client.watermarkPng
      ? {
          watermarkPng: (input: Parameters<NonNullable<MediaToolClient["watermarkPng"]>>[0]) =>
            invoke("transcode", input.signal, (signal) =>
              raw.client.watermarkPng!({ ...input, signal }),
            ),
        }
      : {}),
    ...(raw.client.watermarkSample
      ? {
          watermarkSample: (
            input: Parameters<NonNullable<MediaToolClient["watermarkSample"]>>[0],
          ) =>
            invoke("transcode", input.signal, (signal) =>
              raw.client.watermarkSample!({ ...input, signal }),
            ),
        }
      : {}),
  };
  const workspace: MediaWorkspace = {
    run: <T>(
      job: { id: string; attemptNo: number },
      signal: AbortSignal,
      action: (work: MediaWorkSession) => Promise<T>,
    ) =>
      invoke("probe", signal, (owned) =>
        raw.workspace.run(job, owned, (work) =>
          action({
            path: work.path,
            download: (input) => {
              guardProviderCall({ provider: "media", method: "probe" });
              return work.download(input);
            },
            publish: (input) => {
              guardProviderCall({ provider: "media", method: "transcode" });
              return work.publish(input);
            },
          }),
        ),
      ),
    close: () => tools.close(),
  };
  const tools: ProductionMediaTools = {
    client,
    workspace,
    close: () =>
      (closing ??= (async () => {
        closed = true;
        for (const controller of active) controller.abort();
        try {
          await raw.close();
        } finally {
          await Promise.allSettled([...pending]);
        }
      })()),
  };
  return tools;
}

/** Both process entries use the guarded kernel factory and close only their own tools. */
export function createRuntimeMediaProduction(
  configured: Env["MEDIA_PRODUCTION"],
  providers: Providers,
  override?: { appEnv: Env["APP_ENV"]; tools: ProductionMediaTools },
): { production?: MediaProductionDeps; close(): Promise<void> } {
  if (override && (!["local", "test"].includes(override.appEnv) || !configured))
    throw new TypeError("媒体测试工具只可在本地或测试环境的完整制作配置中注入");
  if (!configured) return { close: async () => {} };
  const tools = override
    ? guardedTestTools(override.tools)
    : assembleProductionMediaTools({
        workDir: configured.workDir,
        socketPath: configured.socketPath,
        storage: providers.storage,
      });
  let closing: Promise<void> | undefined;
  const common = {
    tool: tools.client,
    workspace: tools.workspace,
    cloud: providers.media,
    // D5 §4.7: final cap 200 MiB and the 180-second soft warning. No unregistered parameter keys.
    parameters: async () => ({
      finalMaxMb: 200,
      softDurationMs: 180_000,
      ruleVersion: 1,
      specVersion: 1,
    }),
    readStoreFacts: readStoreMediaFacts,
    readAdDurations: readAdDurationFacts,
    readAdKind: readAdProductionKind,
    readMasterFacts: readMasterProductionFacts,
    readTrailerFacts: readTrailerMediaFacts,
    setTrailerTarget,
    installTrailerCurrent,
  };
  const production: MediaProductionDeps =
    "aigc" in configured
      ? { ...common, config: { aigc: configured.aigc, templates: configured.templates } }
      : { ...common, mode: configured.mode, config: null };
  return {
    production,
    close: () => (closing ??= tools.close()),
  };
}
