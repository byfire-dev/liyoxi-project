// Corresponding-source test entry. Uses the real worker scheduler, PG lease and BullMQ consumers.
// No application-to-application imports; the infra controller owns the API's separate process.
import { pathToFileURL } from "node:url";
import { buildWorkerServices } from "@liyoxi/services";
import { createM1WorkerResources, waitM1Worker } from "@liyoxi/services/testing";
import type { M1LoopWorkerSnapshot } from "@liyoxi/services/testing";
import { createWorkerRuntime, LOOP_INTERVALS_MS, QUEUE_CONCURRENCY } from "../../src/runtime.js";
import { DOMAIN_LOOPS } from "../../src/domain-loops.js";
import type { Logger } from "../../src/log.js";

/** Only necessary transport scheduling is accelerated; all other cadence/lease/concurrency is real. */
export const MIXED_WORKER_INTERVALS = {
  intervals: { outbox_relay: 100, outbox_dispatch: 100, timer_scan: 100 },
  domainIntervals: { media_job_run: 100 },
} as const;

type StartupPhase = "resources" | "build" | "self-check" | "lease" | "snapshot";
class WorkerStartupFailure extends Error {
  constructor(readonly phase: StartupPhase) {
    super("M1 worker受控阶段失败");
  }
}

export async function startM1LoopWorker(raw: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let resources: Awaited<ReturnType<typeof createM1WorkerResources>>;
  try {
    resources = await createM1WorkerResources(raw, Object.keys(QUEUE_CONCURRENCY));
  } catch {
    throw new WorkerStartupFailure("resources");
  }
  let phase: StartupPhase = "build";
  const lifetime = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let runtime: ReturnType<typeof createWorkerRuntime> | undefined;
  let errors = 0,
    closing: Promise<void> | undefined;
  let timerPaused = false;
  const handled = { event: 0, timer: 0, media: 0 };
  const errorSources = new Map<string, number>();
  const errorChannels = new Map<string, number>();
  const knownChannels = new Set(["robot", "sms", "bell", "note", "state", "round"]);
  const knownErrorEvents = new Set([
    "ops.probe_incomplete",
    "ops.alert_facts_closed",
    "ops.alert_unknown_rule",
    "ops.alert_write_failed",
    "ops.alert_channel_failed",
    "profile.consistency_notification_failed",
  ]);
  const knownLoops = new Set([
    ...Object.keys(LOOP_INTERVALS_MS),
    ...DOMAIN_LOOPS.map((loop) => loop.name),
    "media_job_run.pause",
  ]);
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (fields) => {
      errors++;
      const source =
        typeof fields.evt === "string" && knownErrorEvents.has(fields.evt)
          ? fields.evt
          : typeof fields.loop === "string" && knownLoops.has(fields.loop)
            ? fields.loop
            : "other";
      errorSources.set(source, (errorSources.get(source) ?? 0) + 1);
      if (
        fields.evt === "ops.alert_channel_failed" &&
        typeof fields.channel === "string" &&
        knownChannels.has(fields.channel)
      )
        errorChannels.set(fields.channel, (errorChannels.get(fields.channel) ?? 0) + 1);
    },
  };
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      signal?.removeEventListener("abort", abort);
      const results = await Promise.allSettled([Promise.resolve().then(() => runtime?.stop())]);
      try {
        await resources.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      if (results.some((result) => result.status === "rejected"))
        throw new Error("M1 worker关停未完成");
    })());
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    activeSignal.throwIfAborted();
    const base = buildWorkerServices({ ...resources.options, logger });
    const webhooks = base.webhooks;
    if (!webhooks) throw new Error("M1 worker缺正式回调接收公口");
    const services: typeof base = {
      ...base,
      consume: (ref) => {
        handled.event++;
        return base.consume(ref);
      },
      runTimer: (ref) => {
        handled.timer++;
        return base.runTimer(ref);
      },
      promoteFile: (ref) => {
        handled.media++;
        return base.promoteFile(ref);
      },
      scanPromote: async (beat) => {
        const count = await base.scanPromote(beat);
        await resources.pumpWechatCallbacks(webhooks);
        return count;
      },
    };
    runtime = createWorkerRuntime({
      services,
      channel: resources.channel,
      lease: resources.lease,
      logger,
      ...MIXED_WORKER_INTERVALS,
      exit: () => {
        errors++;
        void close().catch(() => undefined);
      },
    });
    phase = "self-check";
    await services.selfCheck();
    activeSignal.throwIfAborted();
    phase = "lease";
    runtime.start();
    await waitM1Worker(
      async () => {
        await resources.assertOwned();
        return runtime?.active && (await resources.channel.ping()) ? true : null;
      },
      () => activeSignal.throwIfAborted(),
      activeSignal,
    );
    return {
      close,
      async pauseTimers() {
        activeSignal.throwIfAborted();
        await runtime!.loops.timer_scan.stop(); // includes the in-flight scan, not just its timeout
        await waitM1Worker(
          async () => ((await resources.timerBarrierReady()) ? true : null),
          () => activeSignal.throwIfAborted(),
          activeSignal,
        );
        timerPaused = true;
      },
      async resumeTimers() {
        activeSignal.throwIfAborted();
        if (!timerPaused || !runtime!.active) throw new Error("M1 timer屏障没有持有主租约");
        timerPaused = false;
        runtime!.loops.timer_scan.start();
      },
      async snapshot(): Promise<
        M1LoopWorkerSnapshot & {
          errorSources: Record<string, number>;
          errorChannels: Record<string, number>;
        }
      > {
        activeSignal.throwIfAborted();
        let snapshot: Awaited<ReturnType<typeof resources.snapshot>>;
        try {
          snapshot = await resources.snapshot();
        } catch {
          throw new WorkerStartupFailure("snapshot");
        }
        return {
          ...snapshot,
          active: runtime!.active,
          errors,
          errorSources: Object.fromEntries(errorSources),
          errorChannels: Object.fromEntries(errorChannels),
          timerPaused,
          handled: { ...handled },
          cadence: MIXED_WORKER_INTERVALS,
        };
      },
    };
  } catch {
    try {
      await close();
    } catch {
      throw new Error("M1 worker启动及清理失败");
    }
    throw new WorkerStartupFailure(phase);
  }
}

// Messages and credentials stay on the owned IPC channel, never stdout/artifacts.
async function main() {
  if (!process.send) throw new Error("M1 worker需要自有IPC启动");
  let worker: Awaited<ReturnType<typeof startM1LoopWorker>> | undefined;
  let started = false,
    stopped = false;
  const lifetime = new AbortController();
  let starting: Promise<Awaited<ReturnType<typeof startM1LoopWorker>>> | undefined;
  let pending = Promise.resolve();
  const send = (value: unknown) =>
    new Promise<void>((resolve, reject) => {
      process.send!(value, (error: Error | null) => (error ? reject(error) : resolve()));
    });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    await starting?.catch(() => undefined);
    await worker?.close();
  };
  const terminate = () => {
    void stop()
      .catch(() => {
        process.exitCode = 1;
      })
      .finally(() => process.disconnect?.());
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  process.once("disconnect", () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
  process.on("message", (raw: unknown) => {
    pending = pending
      .then(async () => {
        if (
          !raw ||
          typeof raw !== "object" ||
          !("id" in raw) ||
          !Number.isSafeInteger(raw.id) ||
          !("command" in raw)
        )
          throw new Error("M1 worker消息不合法");
        const { id, command } = raw;
        try {
          if (command === "start" && !started && !stopped && "attach" in raw) {
            started = true;
            starting = startM1LoopWorker(raw.attach, lifetime.signal);
            worker = await starting;
            await send({ id, ok: true, protocol: "m1-worker-v1", ...(await worker.snapshot()) });
          } else if (command === "snapshot" && worker && !stopped) {
            await send({ id, ok: true, ...(await worker.snapshot()) });
          } else if (command === "pause-timers" && worker && !stopped) {
            await worker.pauseTimers();
            await send({ id, ok: true, ...(await worker.snapshot()) });
          } else if (command === "resume-timers" && worker && !stopped) {
            await worker.resumeTimers();
            await send({ id, ok: true, ...(await worker.snapshot()) });
          } else if (command === "stop" && worker) {
            await stop();
            await send({ id, ok: true });
            process.disconnect();
          } else throw new Error("M1 worker命令不匹配当前阶段");
        } catch (error) {
          await stop().catch(() => undefined);
          await send({
            id,
            ok: false,
            phase: error instanceof WorkerStartupFailure ? error.phase : "worker",
          });
          process.exitCode = 1;
          process.disconnect?.();
        }
      })
      .catch(async () => {
        await stop().catch(() => undefined);
        process.exitCode = 1;
        process.disconnect?.();
      });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  void main().catch(() => {
    process.exitCode = 1;
  });
