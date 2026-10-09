import { createMediaToolClient } from "./client.js";
import { createMediaWorkspace } from "./work-io.js";
import { failed } from "../types.js";
import type {
  BeforeProviderCall,
  MediaToolClient,
  ProductionMediaTools,
  StorageProvider,
} from "../types.js";
export type { ProductionMediaTools } from "../types.js";
/** Composition-only factory. Guards remain before validation/pre-abort and socket/file I/O. */
export function createProductionMediaTools(options: {
  workDir: string;
  socketPath: string;
  storage: StorageProvider;
  beforeCall: BeforeProviderCall;
}): ProductionMediaTools {
  const raw = createMediaToolClient({ workDir: options.workDir, socketPath: options.socketPath });
  const pending = new Set<Promise<unknown>>(),
    active = new Set<AbortController>();
  let closed = false;
  const invoke = <T>(
    method: "probe" | "transcode",
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    options.beforeCall({ provider: "media", method });
    if (closed) return Promise.resolve(failed("unavailable", "mediatool已关闭") as T);
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    active.add(controller);
    const promise = action(controller.signal);
    pending.add(promise);
    return promise.finally(() => {
      signal?.removeEventListener("abort", abort);
      active.delete(controller);
      pending.delete(promise);
    });
  };
  const client: MediaToolClient = {
    probe: (input) => invoke("probe", input.signal, (signal) => raw.probe({ ...input, signal })),
    poster: (input) => invoke("probe", input.signal, (signal) => raw.poster({ ...input, signal })),
    stampAigc: (input) =>
      invoke("transcode", input.signal, (signal) => raw.stampAigc({ ...input, signal })),
    watermarkPng: (input) =>
      invoke("transcode", input.signal, (signal) => raw.watermarkPng!({ ...input, signal })),
    health: (signal) => invoke("probe", signal, (ownedSignal) => raw.health(ownedSignal)),
  };
  const workspace = createMediaWorkspace({
    workDir: options.workDir,
    storage: options.storage,
    beforeCall: () => options.beforeCall({ provider: "media", method: "probe" }),
  });
  return {
    client,
    workspace,
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      await workspace.close();
      await Promise.allSettled([...pending]);
    },
  };
}
