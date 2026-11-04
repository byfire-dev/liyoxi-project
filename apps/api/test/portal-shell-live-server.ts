import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { runStartupChecks } from "@liyoxi/services";
import { createPortalLiveFixture } from "@liyoxi/services/testing";
import type { PortalLiveFixture, PortalLiveStage } from "@liyoxi/services/testing";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { provideMerchantDeps } from "../src/merchant/services.js";
import { HANDLERS } from "../src/routes/index.js";
import {
  assertPortalControlPath,
  createPortalLiveControl,
  startPortalControlSocket,
} from "./portal-shell-live-control.js";
import { createPortalLiveMerchant } from "./portal-shell-live-merchant.js";

export const PortalLiveParentMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    v: z.literal(1),
    type: z.literal("start"),
    runId: z.string().regex(/^[a-f0-9]{12}$/),
    portalOrigin: z.string().max(100),
    version: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
    controlSocketPath: z.string().max(100),
  }),
  z.strictObject({ v: z.literal(1), type: z.literal("stop") }),
]);
type Start = Extract<z.infer<typeof PortalLiveParentMessageSchema>, { type: "start" }>;
class PortalLiveStartFailure extends Error {
  constructor(
    readonly stage: PortalLiveStage,
    readonly cleanupFailed: boolean,
  ) {
    super("PORTAL_LIVE_START_FAILED");
  }
}

/** Private process only; the production app and all production middleware are unchanged. */
export async function startPortalShellLiveServer(
  input: Start,
  signal: AbortSignal,
  onStage: (stage: PortalLiveStage) => void,
) {
  let fixture: PortalLiveFixture | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let api: ReturnType<typeof createApp> | undefined;
  let merchant: ReturnType<typeof createPortalLiveMerchant> | undefined;
  let control: ReturnType<typeof createPortalLiveControl> | undefined;
  let socket: Awaited<ReturnType<typeof startPortalControlSocket>> | undefined;
  let closing: Promise<void> | undefined;
  let lastStage: PortalLiveStage = "scope";
  const report = (stage: PortalLiveStage) => {
    if (stage !== "closing") lastStage = stage;
    onStage(stage);
  };
  const close = () =>
    (closing ??= (async () => {
      report("closing");
      if (api) api.readiness.state = "draining";
      let failed = false;
      const attempt = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch {
          failed = true;
        }
      };
      // Abort any private HTTP request before draining the serial control queue.
      merchant?.close();
      await attempt(async () => (socket ? socket.close() : control?.close()));
      await attempt(async () => {
        if (!http) return;
        await new Promise<void>((resolveClose, reject) => {
          http!.close((error) => (error ? reject(error) : resolveClose()));
          if ("closeAllConnections" in http!) http!.closeAllConnections();
        });
      });
      await attempt(async () => fixture?.close());
      if (failed) throw new Error("PORTAL_LIVE_CLOSE_FAILED");
    })());
  try {
    report("scope");
    await assertPortalControlPath(input.runId, input.controlSocketPath);
    signal.throwIfAborted();
    fixture = await createPortalLiveFixture({
      ...input,
      signal,
      diagnostic: ({ stage }) => report(stage),
    });
    signal.throwIfAborted();
    provideMerchantDeps(fixture.runtime, fixture.merchantDeps);
    api = createApp({ runtime: fixture.runtime, handlers: HANDLERS });
    await runStartupChecks(fixture.runtime.startupChecks);
    signal.throwIfAborted();
    report("http");
    const apiPort = await new Promise<number>((resolvePort, reject) => {
      http = serve({ hostname: "127.0.0.1", port: 0, fetch: api!.app.fetch }, (address) => {
        http?.off("error", reject);
        resolvePort(address.port);
      });
      http.once("error", reject);
    });
    http!.on("error", () => {});
    signal.throwIfAborted();
    report("identities");
    merchant = createPortalLiveMerchant(apiPort, fixture);
    const cancel = () => merchant?.close();
    signal.addEventListener("abort", cancel, { once: true });
    const actors = await merchant
      .prepare()
      .finally(() => signal.removeEventListener("abort", cancel));
    signal.throwIfAborted();
    report("control");
    control = createPortalLiveControl(fixture, merchant);
    socket = await startPortalControlSocket(input.runId, input.controlSocketPath, control);
    signal.throwIfAborted();
    api.readiness.state = "ready";
    return {
      ready: {
        v: 1 as const,
        event: "ready" as const,
        runId: input.runId,
        version: input.version,
        apiPort,
        controlSocketPath: input.controlSocketPath,
        actors,
      },
      close,
    };
  } catch (error) {
    // The fixture may have failed before returning its handle, after doing its own close.
    let cleanupFailed = error instanceof Error && error.message === "PORTAL_LIVE_CLOSE_FAILED";
    try {
      await close();
    } catch {
      cleanupFailed = true;
    }
    throw new PortalLiveStartFailure(lastStage, cleanupFailed);
  }
}

async function main() {
  if (!process.send || !process.connected) {
    process.stderr.write("portal live requires parent IPC\n");
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  let stage: PortalLiveStage = "scope";
  let runId: string | undefined;
  let startup: ReturnType<typeof startPortalShellLiveServer> | undefined;
  let shutdown: Promise<void> | undefined;
  let failed = false;
  const send = (event: unknown) => {
    if (process.connected) process.send?.(event, () => {});
  };
  const stop = () =>
    (shutdown ??= (async () => {
      controller.abort();
      try {
        // Startup has its own complete cleanup and failure event; don't relabel a cleanly
        // recovered startup error as a second CLOSE_FAILED.
        const running = await startup?.catch(() => undefined);
        await running?.close();
        if (!failed && runId) send({ v: 1, event: "closed", runId });
      } catch {
        failed = true;
        send({ v: 1, event: "failed", stage: "closing", code: "CLOSE_FAILED" });
      } finally {
        process.exitCode = failed ? 1 : 0;
        if (process.connected) process.disconnect();
      }
    })());
  process.on("message", (raw: unknown) => {
    const parsed = PortalLiveParentMessageSchema.safeParse(raw);
    if (!parsed.success || (parsed.data.type === "start" && startup)) {
      failed = true;
      send({ v: 1, event: "failed", stage, code: "START_FAILED" });
      void stop();
      return;
    }
    if (parsed.data.type === "stop") {
      void stop();
      return;
    }
    if (shutdown) return;
    runId = parsed.data.runId;
    startup = startPortalShellLiveServer(parsed.data, controller.signal, (next) => {
      stage = next;
    });
    void startup
      .then((running) => {
        if (!controller.signal.aborted) send(running.ready);
      })
      .catch((error: unknown) => {
        failed = true;
        send({
          v: 1,
          event: "failed",
          stage: error instanceof PortalLiveStartFailure ? error.stage : stage,
          code:
            error instanceof PortalLiveStartFailure && error.cleanupFailed
              ? "CLOSE_FAILED"
              : "START_FAILED",
        });
        void stop();
      });
  });
  process.once("disconnect", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

// Importing protocol tests must not start a server. No loader is borrowed from another app.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void realpath(process.argv[1])
    .then(() => main())
    .catch(() => {
      process.stderr.write("portal live startup failed\n");
      process.exitCode = 1;
    });
}
