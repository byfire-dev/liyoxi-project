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

/** Test-only media transport: validate the real owned grant on every request, including HEAD.
 * Range parsing happens only after the fixture has fetched and verified the owned object.
 */
export function portalLiveMediaResponse(
  request: Request,
  input: Pick<Start, "runId" | "portalOrigin">,
  fixture: Pick<PortalLiveFixture, "readPreviewMedia">,
): Response | undefined {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/__portal-live/")) return;
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  const empty = (status: number) => new Response(null, { status, headers });
  const prefix = `/__portal-live/${input.runId}/media/`;
  if (
    !/^[a-f0-9]{12}$/.test(input.runId) ||
    !url.pathname.startsWith(prefix) ||
    !/^[a-f0-9]{32}$/.test(url.pathname.slice(prefix.length)) ||
    url.search ||
    url.hash
  )
    return empty(404);
  if (request.headers.get("host") !== new URL(input.portalOrigin).host) return empty(421);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== input.portalOrigin) return empty(403);
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("allow", "GET, HEAD");
    return empty(405);
  }
  try {
    const media = fixture.readPreviewMedia(url.pathname);
    if (media.status !== 200) return empty(media.status);
    if (
      media.bytes.byteLength < 1 ||
      media.bytes.byteLength > 4 * 1024 * 1024 ||
      (media.mime !== "video/mp4" && media.mime !== "image/jpeg") ||
      !/^"[a-f0-9]{64}"$/.test(media.etag) ||
      !Number.isFinite(Date.parse(media.expiresAt))
    )
      return empty(500);
    const size = media.bytes.byteLength;
    headers.set("content-type", media.mime);
    headers.set("content-length", String(size));
    headers.set("accept-ranges", "bytes");
    headers.set("etag", media.etag);
    headers.set("expires", new Date(media.expiresAt).toUTCString());
    // RFC byte ranges apply to GET; HEAD retains the full representation metadata.
    if (request.method === "HEAD") return empty(200);
    const range = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    if (range === null || (ifRange !== null && ifRange !== media.etag))
      return new Response(new Uint8Array(media.bytes), { status: 200, headers });
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid = () => {
      headers.delete("content-length");
      headers.set("content-range", `bytes */${size}`);
      return empty(416);
    };
    if (!match || (!match[1] && !match[2])) return invalid();
    const first = match[1] ? Number(match[1]) : undefined;
    const last = match[2] ? Number(match[2]) : undefined;
    if (
      (first !== undefined && !Number.isSafeInteger(first)) ||
      (last !== undefined && !Number.isSafeInteger(last))
    )
      return invalid();
    let start: number, end: number;
    if (first === undefined) {
      if (last === undefined || last === 0) return invalid();
      start = Math.max(0, size - last);
      end = size - 1;
    } else {
      start = first;
      end = Math.min(last ?? size - 1, size - 1);
      if (start >= size || end < start) return invalid();
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(new Uint8Array(media.bytes.subarray(start, end + 1)), {
      status: 206,
      headers,
    });
  } catch {
    // Neither a provider exception nor the signed grant is sent to the browser or logger.
    return empty(500);
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
      http = serve(
        {
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request, bindings) =>
            portalLiveMediaResponse(request, input, fixture!) ?? api!.app.fetch(request, bindings),
        },
        (address) => {
          http?.off("error", reject);
          resolvePort(address.port);
        },
      );
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
