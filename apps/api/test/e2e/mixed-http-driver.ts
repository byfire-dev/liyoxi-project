// Corresponding-source test composition. Only the fixed private pipe carries capabilities.
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "@liyoxi/contract";
import {
  assertM1WorkerKnown,
  M1WorkerAttachmentSchema,
  waitM1Worker,
} from "@liyoxi/services/testing";
import type { M1Attachment } from "@liyoxi/services/testing";
import { createM1HttpBridge } from "./http-bridge.js";
import { createMixedOwner } from "./mixed-http-driver.owner.js";
import { readMixedOpenApi, MixedReadSpec } from "./mixed-openapi-reader.js";
import {
  assertMixedSource,
  MixedAccess,
  MixedAdmin,
  MixedFailure,
  MixedSource,
  MIXED_PROTOCOL,
  serveMixedRpc,
  mixedDiagnostics,
} from "./mixed-http-driver.protocol.js";
import type { MixedErrorCode, MixedRequestValue } from "./mixed-http-driver.protocol.js";

const count = z.int().nonnegative();
const WorkerSnapshot = z.object({
  pid: z.int().positive(),
  version: MixedSource,
  active: z.boolean(),
  errors: count,
  timerPaused: z.boolean(),
  lease: z.object({ held: z.boolean(), version: MixedSource }).nullable(),
  backlog: z.object({
    unpublished: count,
    unsettled: count,
    deadDeliveries: count,
    dueTimers: count,
    deadTimers: count,
    mediaPending: count,
    mediaFailed: count,
    published: count,
    consumed: count,
    kinds: z.object({
      events: z.array(z.string()).max(512),
      subscribers: z.array(z.string()).max(512),
      timers: z.array(z.string()).max(512),
      media: z.array(z.string()).max(512),
    }),
  }),
  handled: z.object({ event: count, timer: count, media: count }),
  queues: z
    .array(
      z.object({
        name: z.enum(["outbox_delivery", "timer_run", "notify", "media_job", "promote"]),
        waiting: count,
        active: count,
        failed10Min: count,
        paused: z.boolean(),
      }),
    )
    .min(1),
  cadence: z.object({
    intervals: z.object({
      outbox_relay: z.int().positive(),
      outbox_dispatch: z.int().positive(),
      timer_scan: z.int().positive(),
    }),
    domainIntervals: z.object({ media_job_run: z.int().positive() }),
  }),
});
const Start = z.strictObject({
  source: MixedSource,
  attach: M1WorkerAttachmentSchema,
  phase: z.enum(["head-write", "old-read-write", "head-read"]),
});
const Chain = z.strictObject({ admin: MixedAdmin.optional() });
const Read = z.strictObject({
  previousAccess: MixedAccess,
  observedReads: z.array(z.string().startsWith("/api/v1/").max(4096)).max(1024),
  previousSource: MixedSource.optional(),
  readSpec: MixedReadSpec.optional(),
});
const Empty = z.strictObject({});

function createPhase(
  source: string,
  signal: AbortSignal,
  diagnostics: ReturnType<typeof mixedDiagnostics>,
) {
  let bridge: Awaited<ReturnType<typeof createM1HttpBridge>> | undefined;
  let child: ReturnType<typeof fork> | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let attach: M1Attachment | undefined, phase: z.output<typeof Start>["phase"] | undefined;
  let started = false,
    chainRan = false,
    sequence = 0,
    closing: Promise<unknown> | undefined;
  const command = (name: string, initial?: M1Attachment, cleanup = false) =>
    new Promise<unknown>((resolve, reject) => {
      if (!child?.connected) return reject(new MixedFailure("start_failed"));
      const active = child,
        id = ++sequence;
      const timer = setTimeout(
        () => done(new MixedFailure("start_failed")),
        cleanup ? 10_000 : 30_000,
      );
      const abort = () => done(new MixedFailure("cancelled"));
      const receive = (raw: unknown) => {
        const response = z.object({ id: z.int(), ok: z.boolean() }).passthrough().safeParse(raw);
        if (!response.success || response.data.id !== id) return;
        if (!response.data.ok) return done(new MixedFailure("start_failed"));
        clear();
        resolve(raw);
      };
      const fail = () => done(new MixedFailure("start_failed"));
      function clear() {
        clearTimeout(timer);
        active.off("message", receive);
        active.off("close", fail);
        signal.removeEventListener("abort", abort);
      }
      function done(error: Error) {
        clear();
        reject(error);
      }
      active.on("message", receive);
      active.once("close", fail);
      if (!cleanup) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) return abort();
      }
      active.send({ id, command: name, ...(initial ? { attach: initial } : {}) }, (error) => {
        if (error) done(new MixedFailure("start_failed"));
      });
    });
  const snapshot = async () => {
    const value = WorkerSnapshot.parse(await command("snapshot"));
    if (!bridge) throw new MixedFailure("invalid_state");
    assertM1WorkerKnown(
      value.backlog,
      bridge.support.runtime.events.subscribers.all.map((row) => row.name),
    );
    if (
      !attach ||
      value.pid !== child?.pid ||
      value.version !== source ||
      !value.active ||
      !value.lease?.held ||
      value.lease.version !== source ||
      value.errors ||
      diagnostics.count() ||
      value.queues.some((row) => row.failed10Min)
    )
      throw new MixedFailure("drain_failed");
    return value;
  };
  const close = () =>
    (closing ??= (async () => {
      const work: Promise<unknown>[] = [];
      if (child && exited) {
        const active = child,
          actualExit = exited;
        work.push(
          (async () => {
            let kill: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
            try {
              const outcome = await Promise.race([
                (async () => {
                  if (active.connected)
                    await command("stop", undefined, true).catch(() => active.kill("SIGTERM"));
                  return actualExit;
                })(),
                new Promise<never>((_resolve, reject) => {
                  kill = setTimeout(() => active.kill("SIGKILL"), 20_000);
                  deadline = setTimeout(() => reject(new MixedFailure("cleanup_failed")), 25_000);
                }),
              ]);
              if (outcome.code !== 0 || outcome.signal !== null)
                throw new MixedFailure("cleanup_failed");
            } finally {
              clearTimeout(kill);
              clearTimeout(deadline);
            }
          })(),
        );
      }
      work.push(Promise.resolve().then(() => bridge?.close()));
      const results = await Promise.allSettled(work);
      if (results.some((row) => row.status === "rejected"))
        throw new MixedFailure("cleanup_failed");
      return { workerStopped: Boolean(child), bridgeClosed: Boolean(bridge) };
    })());
  return {
    close,
    async start(raw: unknown) {
      if (started || closing || process.env.APP_ENV !== "local")
        throw new MixedFailure("invalid_state");
      const input = Start.parse(raw);
      assertMixedSource(input.source, source);
      assertMixedSource(input.attach.version, source);
      started = true;
      attach = input.attach;
      phase = input.phase;
      signal.throwIfAborted();
      const require = createRequire(
        new URL("../../../../packages/services/package.json", import.meta.url),
      );
      child = fork(
        new URL("../../../../apps/worker/test/e2e/mixed-worker.ts", import.meta.url),
        [],
        {
          execArgv: ["--import", require.resolve("tsx")],
          env: {
            PATH: process.env.PATH,
            APP_ENV: "local",
            DATABASE_URL: process.env.DATABASE_URL,
            REDIS_URL: process.env.REDIS_URL,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      child.stdout!.on("data", () => undefined);
      child.stderr!.on("data", () => undefined);
      exited = new Promise((resolve) =>
        child!.once("close", (code, signal) => resolve({ code, signal })),
      );
      WorkerSnapshot.parse(await command("start", attach));
      bridge = await createM1HttpBridge({
        attach,
        signal,
        diagnosticWrite: diagnostics.write,
        beforeOrder: async () => {
          await command("pause-timers");
        },
        backgroundWorker: {
          resumeTimerScan: async () => {
            await command("resume-timers");
          },
        },
      });
      const worker = await snapshot();
      if (worker.timerPaused) throw new MixedFailure("start_failed");
      if (diagnostics.count()) throw new MixedFailure("start_failed");
      return {
        protocol: MIXED_PROTOCOL,
        source,
        apiPid: process.pid,
        worker,
        apiDiagnosticErrors: diagnostics.count(),
      };
    },
    async chain(raw: unknown) {
      if (!bridge || closing || chainRan || phase === "head-read")
        throw new MixedFailure("invalid_state");
      const input = Chain.parse(raw);
      if ((phase === "old-read-write") !== Boolean(input.admin))
        throw new MixedFailure("invalid_state");
      chainRan = true;
      const result = await bridge.runChain({
        ...input,
        onStep: (step) => process.stderr.write(`${JSON.stringify({ mixedChainStep: step })}\n`),
      });
      if (
        diagnostics.count() ||
        result.report.episodeCount !== 20 ||
        result.report.invariants.status !== "succeeded" ||
        result.report.invariants.errors ||
        result.report.invariants.violationsFound ||
        result.report.invariants.checksRun < 1 ||
        result.report.final.order !== "live" ||
        result.report.final.item !== "live" ||
        result.report.final.ticket !== "in_service" ||
        !result.report.final.isLive
      )
        throw new MixedFailure("chain_failed");
      return {
        report: result.report,
        initialization: result.initialization,
        observedReads: result.observedReads,
        access: MixedAccess.parse({
          admin: {
            staffId: result.access.admin.staffId,
            phone: result.access.admin.phone,
            password: result.access.admin.password,
            secret: result.access.admin.secret,
            recoveryCodes: [...result.access.admin.recoveryCodes],
          },
          chainId: attach!.chainId,
          ids: result.access.ids,
        }),
      };
    },
    async read(raw: unknown) {
      if (!bridge || closing) throw new MixedFailure("invalid_state");
      const input = Read.parse(raw);
      if (
        phase === "head-read"
          ? !input.previousSource || !input.readSpec
          : input.previousSource || input.readSpec
      )
        throw new MixedFailure("invalid_state");
      const replay =
        phase === "head-read" && input.previousSource && input.readSpec
          ? { previousSource: input.previousSource, readSpec: input.readSpec }
          : undefined;
      const result = await readMixedOpenApi(bridge.api, {
        previousAccess: input.previousAccess,
        observedReads: input.observedReads,
        source,
        signal,
        ...(replay ? { replay } : {}),
      });
      if (diagnostics.count()) throw new MixedFailure("read_failed");
      return result;
    },
    async drain(raw: unknown) {
      Empty.parse(raw);
      if (!bridge || closing) throw new MixedFailure("invalid_state");
      if ((await snapshot()).timerPaused) await command("resume-timers");
      const drain = await bridge.drain();
      const worker = await waitM1Worker(
        async () => {
          const current = await snapshot();
          const pending =
            current.backlog.unpublished +
            current.backlog.unsettled +
            current.backlog.dueTimers +
            current.backlog.mediaPending;
          return !pending && current.queues.every((row) => !row.waiting && !row.active)
            ? current
            : null;
        },
        () => signal.throwIfAborted(),
        signal,
      );
      return { drain, worker, apiDiagnosticErrors: diagnostics.count() };
    },
  };
}

async function main() {
  const mode = process.argv[2];
  if (!["owner", "phase"].includes(mode ?? "")) throw new MixedFailure("invalid_request");
  const source = MixedSource.parse((await readFile("/repo/.mixed-source-sha", "utf8")).trim());
  const controller = new AbortController();
  const deadline = setTimeout(() => stop(), 540_000);
  const diagnostics = mixedDiagnostics();
  const owner =
    mode === "owner" ? createMixedOwner(source, controller.signal, diagnostics.write) : undefined;
  const phase = mode === "phase" ? createPhase(source, controller.signal, diagnostics) : undefined;
  const stop = () => {
    controller.abort();
    process.stdin.destroy();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await serveMixedRpc(
      process.stdin,
      (line) =>
        new Promise<void>((resolve, reject) =>
          process.stdout.write(line, (error) => (error ? reject(error) : resolve())),
        ),
      async (request: MixedRequestValue) => {
        controller.signal.throwIfAborted();
        const codes: Readonly<Record<MixedRequestValue["method"], MixedErrorCode>> = {
          "owner.init": "start_failed",
          "owner.close": "cleanup_failed",
          "phase.start": "start_failed",
          "phase.chain": "chain_failed",
          "phase.read": "read_failed",
          "phase.drain": "drain_failed",
          "phase.close": "cleanup_failed",
        };
        try {
          let result: unknown;
          switch (request.method) {
            case "owner.init":
              if (owner) result = await owner.init(request.params);
              else throw new MixedFailure("invalid_state");
              break;
            case "owner.close":
              Empty.parse(request.params);
              if (owner) result = await owner.close();
              else throw new MixedFailure("invalid_state");
              break;
            case "phase.start":
              if (phase) result = await phase.start(request.params);
              else throw new MixedFailure("invalid_state");
              break;
            case "phase.chain":
              if (phase) result = await phase.chain(request.params);
              else throw new MixedFailure("invalid_state");
              break;
            case "phase.read":
              if (phase) result = await phase.read(request.params);
              else throw new MixedFailure("invalid_state");
              break;
            case "phase.drain":
              if (phase) result = await phase.drain(request.params);
              else throw new MixedFailure("invalid_state");
              break;
            case "phase.close":
              Empty.parse(request.params);
              if (phase) result = await phase.close();
              else throw new MixedFailure("invalid_state");
              break;
          }
          if (diagnostics.count()) throw new MixedFailure(codes[request.method]);
          return result;
        } catch (error) {
          // Diagnostic locations only: no message, first stack line, SQL, cause or private RPC value.
          const frames =
            error instanceof Error
              ? (error.stack ?? "")
                  .split("\n")
                  .slice(1)
                  .flatMap((line) => {
                    const match = line.match(
                      /^\s+at [^\n]*\/repo\/((?:apps|packages)\/(?:[\w.-]+\/)*[\w.-]+\.[cm]?[jt]sx?):(\d+):(\d+)/,
                    );
                    return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
                  })
                  .slice(0, 8)
              : [];
          process.stderr.write(
            `${JSON.stringify({
              mixedFailure: codes[request.method],
              method: request.method,
              errorCategory:
                error instanceof Error &&
                [
                  "Error",
                  "AssertionError",
                  "ZodError",
                  "MixedFailure",
                  "AppError",
                  "TypeError",
                  "AggregateError",
                ].includes(error.name)
                  ? error.name
                  : "other",
              diagnosticCount: diagnostics.count(),
              frames,
            })}\n`,
          );
          throw error instanceof MixedFailure
            ? error
            : new MixedFailure(controller.signal.aborted ? "cancelled" : codes[request.method]);
        }
      },
    );
  } finally {
    controller.abort();
    clearTimeout(deadline);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await Promise.all([owner?.close(), phase?.close()]);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  void main().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        errorCode: error instanceof MixedFailure ? error.code : "invalid_request",
      }) + "\n",
    );
    process.exitCode = 1;
  });
