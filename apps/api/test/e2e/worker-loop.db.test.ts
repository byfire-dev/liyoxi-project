import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import { z } from "@liyoxi/contract";
import { EVENTS, JOBS, LOOPS, SUBSCRIBERS, TIMERS } from "@liyoxi/contract/registry";
import {
  FILE_OBJECT_STATUS,
  INVITATION_STATUS,
  MEDIA_JOB_KIND,
  MEDIA_JOB_STATE,
  TIMER_STATUS,
} from "@liyoxi/contract/enums";
import {
  createM1Support,
  createM1RealClock,
  prepareM1WorkerExercise,
  waitM1Worker,
} from "@liyoxi/services/testing";
import type { M1Attachment } from "@liyoxi/services/testing";

const knownKinds = (values: readonly string[], registered: readonly string[]) => {
  const known = values.filter((value) => registered.includes(value));
  return { known, unknownCount: values.length - known.length };
};
const BacklogSchema = z.object({
  unpublished: z.int().nonnegative(),
  unsettled: z.int().nonnegative(),
  deadDeliveries: z.int().nonnegative(),
  dueTimers: z.int().nonnegative(),
  deadTimers: z.int().nonnegative(),
  mediaPending: z.int().nonnegative(),
  mediaFailed: z.int().nonnegative(),
  published: z.int().nonnegative(),
  consumed: z.int().nonnegative(),
  kinds: z
    .object({
      events: z.array(z.string()).max(512),
      subscribers: z.array(z.string()).max(512),
      timers: z.array(z.string()).max(512),
      media: z.array(z.string()).max(512),
    })
    .transform((kinds) => ({
      events: knownKinds(
        kinds.events,
        EVENTS.map((row) => row.name),
      ),
      subscribers: knownKinds(
        kinds.subscribers,
        SUBSCRIBERS.map((row) => row.name),
      ),
      timers: knownKinds(
        kinds.timers,
        [...TIMERS, ...JOBS].map((row) => row.kind),
      ),
      media: knownKinds(kinds.media, MEDIA_JOB_KIND.values),
    })),
});
const SnapshotSchema = z.object({
  pid: z.int().positive(),
  version: z.string().regex(/^[a-f0-9]{40}$/),
  lease: z.object({ held: z.boolean(), version: z.string().regex(/^[a-f0-9]{40}$/) }).nullable(),
  active: z.boolean(),
  errors: z.int().nonnegative(),
  errorSources: z.record(
    z
      .string()
      .refine(
        (value) =>
          [
            "other",
            "ops.probe_incomplete",
            "ops.alert_facts_closed",
            "ops.alert_unknown_rule",
            "ops.alert_write_failed",
            "ops.alert_channel_failed",
            "profile.consistency_notification_failed",
            "media_job_run.pause",
          ].includes(value) || LOOPS.some((loop) => loop.id === value),
      ),
    z.int().nonnegative(),
  ),
  errorChannels: z.partialRecord(
    z.enum(["robot", "sms", "bell", "note", "state", "round"]),
    z.int().nonnegative(),
  ),
  backlog: BacklogSchema,
  backupIo: z.object({
    processes: z.object({
      version: z.int().nonnegative(),
      dump: z.int().nonnegative(),
      age: z.int().nonnegative(),
    }),
    activeChildren: z.int().nonnegative(),
    put: z.int().nonnegative(),
    head: z.int().nonnegative(),
    copy: z.int().nonnegative(),
    objects: z.int().nonnegative(),
    bytes: z.array(z.int().positive()),
  }),
  alertSmsCalls: z.int().nonnegative(),
  timerPaused: z.boolean(),
  handled: z.object({
    event: z.int().nonnegative(),
    timer: z.int().nonnegative(),
    media: z.int().nonnegative(),
  }),
  queues: z
    .array(
      z.object({
        waiting: z.int().nonnegative(),
        active: z.int().nonnegative(),
        failed10Min: z.int().nonnegative(),
      }),
    )
    .min(1),
});
type Snapshot = z.output<typeof SnapshotSchema>;
const FactsSchema = z.object({
  invitation: z.object({ status: z.enum(INVITATION_STATUS.values) }),
  timer: z.object({ status: z.enum(TIMER_STATUS.values), dispatchNo: z.int().nonnegative() }),
  file: z.object({ status: z.enum(FILE_OBJECT_STATUS.values) }),
  jobs: z.array(
    z.object({
      kind: z.enum(MEDIA_JOB_KIND.values),
      state: z.enum(MEDIA_JOB_STATE.values),
      attemptNo: z.int().nonnegative(),
    }),
  ),
});

it("独立worker持真实租约与队列：timer屏障、邀请到期、promote/probe、未知拒绝及暂停取消收尾", async () => {
  vi.stubEnv("APP_ENV", "test");
  const owner = await createM1Support({ clock: createM1RealClock() });
  const scope = owner.sharedScope();
  const attach: M1Attachment = {
    scope,
    chainId: "loops",
    version: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    storage: {
      endpoint: "http://127.0.0.1:9100",
      region: "us-east-1",
      accessKey: "liyoxi",
      secretKey: "lyx-local-dev",
      buckets: {
        secure: `lyx-test-mixed-${scope.runId}-secure`,
        asset: `lyx-test-mixed-${scope.runId}-asset`,
        media: `lyx-test-mixed-${scope.runId}-media`,
        pub: `lyx-test-mixed-${scope.runId}-pub`,
      },
    },
  };
  const io = new S3Client({
    endpoint: attach.storage.endpoint,
    region: attach.storage.region,
    forcePathStyle: true,
    credentials: { accessKeyId: "liyoxi", secretAccessKey: "lyx-local-dev" },
  });
  const absent = (error: unknown) =>
    error instanceof Error && ["NotFound", "NoSuchBucket"].includes(error.name);
  const errors: unknown[] = [],
    buckets: string[] = [];
  let support: Awaited<ReturnType<typeof createM1Support>> | undefined;
  let child: ReturnType<typeof fork> | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let fixture: Awaited<ReturnType<typeof prepareM1WorkerExercise>> | undefined;
  let phase = "prepare";
  let sequence = 0;
  const command = (
    name: "start" | "snapshot" | "pause-timers" | "resume-timers",
    first?: M1Attachment,
    timeoutMs = 30_000,
  ) =>
    new Promise<Snapshot>((resolve, reject) => {
      const active = child!;
      const id = ++sequence;
      const timeout = setTimeout(() => done(new Error("owned worker IPC timeout")), timeoutMs);
      const receive = (raw: unknown) => {
        if (!raw || typeof raw !== "object" || !("id" in raw) || raw.id !== id) return;
        if (!("ok" in raw) || raw.ok !== true) {
          const failure = z
            .object({
              phase: z.enum(["resources", "build", "self-check", "lease", "snapshot", "worker"]),
            })
            .safeParse(raw);
          return done(
            new Error(
              `owned worker IPC rejected: ${name}/${failure.success ? failure.data.phase : "unknown"}`,
            ),
          );
        }
        clearTimeout(timeout);
        active.off("message", receive);
        active.off("exit", failed);
        const parsed = SnapshotSchema.safeParse(raw);
        if (!parsed.success) return reject(new Error("owned worker IPC snapshot invalid"));
        resolve(parsed.data);
      };
      const failed = () => done(new Error("owned worker exited before reply"));
      function done(error: Error) {
        clearTimeout(timeout);
        active.off("message", receive);
        active.off("exit", failed);
        reject(error);
      }
      active.on("message", receive);
      active.once("exit", failed);
      active.send({ id, command: name, ...(first ? { attach: first } : {}) }, (error) => {
        if (error) done(new Error("owned worker IPC send failed"));
      });
    });
  const clean = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    for (const bucket of Object.values(attach.storage.buckets)) {
      try {
        await io.send(new HeadBucketCommand({ Bucket: bucket }), {
          abortSignal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        if (!absent(error)) throw error;
        buckets.push(bucket);
        continue;
      }
      throw new Error("owned bucket already exists");
    }
    vi.stubEnv("APP_ENV", "local");
    support = await createM1Support({
      attach,
      backgroundWorker: {
        resumeTimerScan: async () => {
          await command("resume-timers");
        },
      },
    });
    const require = createRequire(
      new URL("../../../../packages/services/package.json", import.meta.url),
    );
    child = fork(new URL("../../../../apps/worker/test/e2e/mixed-worker.ts", import.meta.url), [], {
      execArgv: ["--import", require.resolve("tsx")],
      env: {
        PATH: process.env.PATH,
        APP_ENV: "local",
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", () => undefined);
    child.stderr!.on("data", () => undefined);
    exited = new Promise((resolve) =>
      child!.once("close", (code, signal) => resolve({ code, signal })),
    );
    phase = "start";
    const started = await command("start", attach);
    expect(started.pid).toBe(child.pid);
    expect(started.pid).not.toBe(process.pid);
    expect(started.lease).toMatchObject({ held: true, version: attach.version });
    phase = "pause-before-target";
    expect((await command("pause-timers")).timerPaused).toBe(true);
    phase = "fixture";
    fixture = await prepareM1WorkerExercise(support);
    expect((await fixture.read()).timer.status).toBe("scheduled");
    expect((await fixture.read()).invitation.status).toBe("pending");
    phase = "promote";
    await support.promote(fixture.fileId);
    phase = "resume-timers";
    await command("resume-timers");
    phase = "drain";
    await support.drainEvents();
    phase = "domain-facts";
    const facts = await fixture.read();
    expect(facts.backup?.status).toBe("fired");
    expect(facts.backup?.summary?.bytes).toBe(64);
    expect(facts.backup?.summary?.pgDumpVersion).toBe("17.6");
    expect(Boolean(facts.backup?.summary?.key.match(/^daily\/\d{4}-\d{2}-\d{2}\.dump\.age$/))).toBe(
      true,
    );
    expect(facts.invitation.status).toBe("expired");
    expect(facts.timer).toMatchObject({ status: "fired", dispatchNo: 1 });
    expect(facts.file).toMatchObject({
      status: "stored",
      sizeBytes: BigInt(support.productionVideo.sizeBytes),
    });
    expect(facts.info).toMatchObject({ width: 720, height: 1280, durationMs: 20_000 });
    expect(facts.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "promote", state: "succeeded", attemptNo: 1 }),
        expect.objectContaining({ kind: "probe", state: "succeeded", provider: "mediatool" }),
      ]),
    );
    phase = "queue-ack";
    const snapshot = await waitM1Worker(
      async () => {
        const current = await command("snapshot");
        if (
          current.errors ||
          !current.active ||
          !current.lease?.held ||
          current.version !== attach.version ||
          current.lease.version !== attach.version ||
          current.queues.some((queue) => queue.failed10Min > 0)
        )
          throw new Error("owned worker failed or lost its lease while waiting for queue ACK");
        return current.queues.every((queue) => queue.waiting === 0 && queue.active === 0)
          ? current
          : null;
      },
      () => undefined,
    );
    expect(snapshot.errors).toBe(0);
    const alerts = (await fixture.read()).alertSms;
    expect(alerts.sent).toBeGreaterThan(0);
    expect(alerts.other).toBe(0);
    expect(snapshot.alertSmsCalls).toBe(alerts.sent);
    expect(snapshot.backupIo.put).toBeGreaterThanOrEqual(1);
    expect(snapshot.backupIo.head).toBe(snapshot.backupIo.put);
    expect(snapshot.backupIo.copy).toBe(
      facts.backup!.summary!.key.endsWith("-01.dump.age") ? snapshot.backupIo.put : 0,
    );
    expect(snapshot.backupIo.objects).toBe(snapshot.backupIo.put + snapshot.backupIo.copy);
    expect(snapshot.backupIo.bytes.every((bytes) => bytes === 64)).toBe(true);
    expect(snapshot.backupIo.processes.version).toBe(snapshot.backupIo.put);
    expect(snapshot.backupIo.processes.dump).toBe(snapshot.backupIo.put);
    expect(snapshot.backupIo.processes.age).toBe(snapshot.backupIo.put);
    expect(snapshot.backupIo.activeChildren).toBe(0);
    expect(snapshot.lease?.held).toBe(true);
    for (const count of Object.values(snapshot.handled)) expect(count).toBeGreaterThan(0);
    expect(
      snapshot.queues.every((q) => q.waiting === 0 && q.active === 0 && q.failed10Min === 0),
    ).toBe(true);
    phase = "pause-before-close";
    await command("pause-timers");
    phase = "close";
    child.kill("SIGTERM"); // real cancellation from the paused state, not a fake close result
    expect(
      await waitM1Worker(
        async () => {
          const value = await Promise.race([exited!, Promise.resolve(null)]);
          return value;
        },
        () => undefined,
      ),
    ).toEqual({ code: 0, signal: null });
    phase = "unknown";
    await fixture.emitUnknown();
    await expect(support.drainEvents()).rejects.toThrow("未知");
  } catch (error) {
    // Only this owned target's enum facts and actual IPC counts; diagnostic failure cannot mask it.
    const current = child?.connected
      ? await command("snapshot", undefined, 1000).catch(() => undefined)
      : undefined;
    const facts = FactsSchema.safeParse(await fixture?.read().catch(() => undefined));
    console.error(
      JSON.stringify({
        phase,
        ...(facts.success ? { facts: facts.data } : {}),
        ...(current
          ? {
              active: current.active,
              held: current.lease?.held ?? false,
              errors: current.errors,
              errorSources: current.errorSources,
              errorChannels: current.errorChannels,
              backlog: current.backlog,
              backupIo: current.backupIo,
              handled: current.handled,
              queues: current.queues,
            }
          : {}),
      }),
    );
    errors.push(error);
  } finally {
    if (child && exited) {
      child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      await clean(async () => {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            child!.kill("SIGKILL");
            reject(new Error("owned worker shutdown timeout"));
          }, 30_000);
        });
        try {
          await Promise.race([exited!, timeout]);
        } catch (error) {
          // SIGKILL is only the owned fallback; still wait for the actual close before dropping DB.
          let killedTimer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              exited!,
              new Promise<never>((_resolve, reject) => {
                killedTimer = setTimeout(
                  () => reject(new Error("owned worker did not close")),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(killedTimer);
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      });
    }
    await clean(() => support?.close());
    const signal = AbortSignal.timeout(30_000);
    for (const bucket of buckets)
      await clean(async () => {
        let token: string | undefined;
        try {
          for (let page = 0; page < 16; page++) {
            const list = await io.send(
              new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 250, ContinuationToken: token }),
              { abortSignal: signal },
            );
            const objects =
              list.Contents?.flatMap((row) => (row.Key ? [{ Key: row.Key }] : [])) ?? [];
            if (objects.length) {
              const result = await io.send(
                new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
                { abortSignal: signal },
              );
              if (result.Errors?.length) throw new Error("owned object cleanup incomplete");
            }
            if (list.IsTruncated === false) break;
            if (list.IsTruncated !== true) throw new Error("owned bucket listing incomplete");
            if (!list.NextContinuationToken || list.NextContinuationToken === token || page === 15)
              throw new Error("owned bucket cleanup limit");
            token = list.NextContinuationToken;
          }
          await io.send(new DeleteBucketCommand({ Bucket: bucket }), { abortSignal: signal });
        } catch (error) {
          if (!absent(error)) throw error;
        }
      });
    await clean(() => io.destroy());
    await clean(() => owner.close());
    vi.unstubAllEnvs();
  }
  if (errors.length) throw new AggregateError(errors, "独立worker代表路径或清理失败");
}, 120_000);
