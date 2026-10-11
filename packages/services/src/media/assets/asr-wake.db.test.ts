import { createHash, createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@liyoxi/db";
import {
  assertNotInTransaction,
  createIdentityContext,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import {
  connectTestDatabase,
  createMediaAssetsHarness,
  useSeededDatabase,
} from "../../testing/index.js";
import { createAsrWebhookSource, createWebhooks } from "../../security/index.js";
import type { WebhookSource } from "../../security/index.js";
import { ok } from "../../providers/types.js";
import { AssetJobInputSchema } from "./pipeline.js";

const database = useSeededDatabase("services");
const key = "public-fake-asr-wake-db-key-at-least-32-bytes";
const context = createIdentityContext({
  actor: { type: "system", job: "hooks.asr.media-job.wake" },
});
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let sequence = 1;
beforeAll(async () => {
  h = await createMediaAssetsHarness(await database.prisma());
}, 120_000);
beforeEach(() => {
  h.fake.asr.resetCalls();
  h.fake.storage.resetCalls();
  h.permitControlledModel(true);
});
afterEach(() => {
  h.permitControlledModel(false);
  vi.restoreAllMocks();
});
afterAll(async () => {
  await h?.close();
});

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeUInt16LE(sequence++, 44);
  bytes.writeUInt16LE(sequence, 46);
  return bytes;
}
async function ready(submit = true) {
  // Real registration/upload/promotion/probe/ASR owner; only external IO is the public fake.
  const bytes = wav();
  const item = (
    await h.media.register(h.owner, {
      category: "store_asset",
      files: [{ fileName: "callback.wav", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
    })
  ).items[0]!;
  h.fake.storage.put({ bucket: "asset", key: item.key }, bytes, "audio/wav");
  await h.media.complete(h.owner, item.fileId);
  const promote = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${item.fileId}` },
  });
  await h.media.jobs.run({ jobId: promote.id });
  const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
  expect(file).toMatchObject({ status: "stored", ext: "wav", sizeBytes: BigInt(bytes.length) });
  const asset = await h.media.assets.create(h.owner, { type: "audio", fileIds: [file.id] });
  const probe = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentType: "store_asset", parentId: asset.storeAssetId, kind: "probe" },
  });
  await h.media.jobs.run({ jobId: probe.id });
  let job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentType: "store_asset", parentId: asset.storeAssetId, kind: "asr" },
  });
  expect(job).toMatchObject({ state: "queued", mode: "remote", provider: "fake", attemptNo: 0 });
  if (submit) {
    await h.media.jobs.run({ jobId: job.id });
    job = await row(job.id);
    expect(job).toMatchObject({ state: "submitted", attemptNo: 1, leaseOwner: null });
    expect(job.externalJobId).toMatch(/^\d+$/);
  }
  h.clock.advance(1);
  h.fake.asr.resetCalls();
  h.fake.storage.resetCalls();
  return { file, assetId: asset.storeAssetId, job };
}
type Facts = Awaited<ReturnType<typeof ready>>;
const row = (id: string) => h.prisma.mediaJob.findUniqueOrThrow({ where: { id } });
function source(
  wake: Parameters<typeof createAsrWebhookSource>[0]["wake"] = (tx, input) =>
    h.media.wakeAsrJob(tx, input),
) {
  return createAsrWebhookSource({ key, configured: () => h.fake.asr.configured, wake });
}
function receiver(registered: WebhookSource = source()) {
  return createWebhooks({ tx: h.tx, clock: h.clock, events: h.events, sources: [registered] });
}
async function callback(facts: Facts, taskId = facts.job.externalJobId!, hooks = receiver()) {
  const body = `requestId=${taskId}&code=9&text=fictional-callback-result&audioUrl=https%3A%2F%2Fprivate.invalid%2Fa`;
  const prepared = await hooks.prepare("asr", {
    method: "POST",
    operationId: "hooks.asr.mediaJob.wake",
    params: { mediaJobId: facts.job.id },
    query: { sig: createHmac("sha256", key).update(facts.job.id).digest("base64url") },
    headers: { "content-type": "application/x-www-form-urlencoded" },
    rawBody: Buffer.from(body),
  });
  if (prepared.kind !== "ready") throw new Error("public signed callback was rejected");
  return { ack: await hooks.accept(prepared, context), body };
}
const receipts = (id: string) =>
  h.prisma.webhookEvent.findMany({
    where: { provider: "asr", eventId: { startsWith: `${id}:` } },
    orderBy: { id: "asc" },
  });
async function snapshot(facts: Facts) {
  return {
    job: await row(facts.job.id),
    asset: await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: facts.assetId } }),
    file: await h.prisma.fileObject.findUniqueOrThrow({ where: { id: facts.file.id } }),
    insights: await h.prisma.storeAssetInsight.findMany({
      where: { storeAssetId: facts.assetId },
      orderBy: { id: "asc" },
    }),
    events: await h.prisma.outboxEvent.findMany({
      where: { aggregateId: facts.assetId },
      orderBy: { id: "asc" },
    }),
  };
}
function noIo() {
  expect(h.fake.asr.calls).toEqual([]);
  expect(h.fake.storage.calls).toEqual([]);
}
async function ignored(facts: Facts, taskId = facts.job.externalJobId!) {
  const before = await snapshot(facts);
  expect((await callback(facts, taskId)).ack).toMatchObject({
    status: 200,
    body: '{"code":0,"message":"success"}',
  });
  expect(await snapshot(facts)).toEqual(before);
  expect(await receipts(facts.job.id)).toEqual([
    expect.objectContaining({ processState: "ignored", eventType: "asr_callback", payload: null }),
  ]);
  noIo();
}
async function changeJob(facts: Facts, data: Prisma.MediaJobUpdateInput) {
  await h.prisma.mediaJob.update({ where: { id: facts.job.id }, data });
}
async function replaceSourceFile(facts: Facts, file: Facts["file"]) {
  await h.prisma.storeAssetFile.update({
    where: { storeAssetId_position: { storeAssetId: facts.assetId, position: 1 } },
    data: { fileId: file.id },
  });
  const input = AssetJobInputSchema.parse(facts.job.input);
  await changeJob(facts, {
    subjectId: file.id,
    input: {
      ...input,
      fileId: file.id,
      etag: file.etag,
      crc64: file.crc64,
      sizeBytes: file.sizeBytes!.toString(),
    },
    dedupeKey: `asset:${facts.assetId}:${input.runId}:asr:${file.id}:v${input.promptVersion}`,
  });
  h.fake.asr.resetCalls();
  h.fake.storage.resetCalls();
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("ASR callback wake: real media ownership and atomic inbox", () => {
  it("valid submitted callback changes only nextRunAt/updatedAt and stores only raw digest", async () => {
    const facts = await ready(),
      before = await snapshot(facts);
    expect(before.job.nextRunAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
    const { ack, body } = await callback(facts);
    expect(ack).toMatchObject({ status: 200, body: '{"code":0,"message":"success"}' });
    expect(await snapshot(facts)).toEqual({
      ...before,
      job: { ...before.job, nextRunAt: h.clock.now(), updatedAt: h.clock.now() },
    });
    expect(await receipts(facts.job.id)).toEqual([
      expect.objectContaining({
        eventId: `${facts.job.id}:${facts.job.externalJobId}`,
        eventType: "asr_callback",
        provider: "asr",
        mode: "inline",
        processState: "processed",
        payload: null,
        keyVersion: null,
        payloadPurgeAt: null,
        payloadDigest: new Uint8Array(createHash("sha256").update(body).digest()),
      }),
    ]);
    expect(JSON.stringify(await receipts(facts.job.id))).not.toContain("fictional-callback-result");
    noIo();
  });

  it("natural replay preserves first receipt and does not move an already due task again", async () => {
    const facts = await ready();
    await callback(facts);
    const before = await snapshot(facts),
      inbox = await receipts(facts.job.id);
    h.clock.advance(1_000);
    expect((await callback(facts)).ack.status).toBe(200);
    expect(await snapshot(facts)).toEqual(before);
    expect(await receipts(facts.job.id)).toEqual(inbox);
    noIo();
  });

  it("early callback is ignored permanently for its natural key; polling remains the fallback", async () => {
    const facts = await ready(false);
    // A callback cannot turn a not-yet-submitted task into an accepted remote task.
    await ignored(facts, "4000048858");
    const submit = vi.spyOn(h.fake.asr, "submit").mockImplementation(async () => {
      assertNotInTransaction("public fake ASR submit");
      h.fake.asr.tasks.set("4000048858", {
        taskId: "4000048858",
        requestId: "public-early-callback",
        state: "waiting",
      });
      return ok({ taskId: "4000048858", requestId: "public-early-callback" });
    });
    await h.media.jobs.run({ jobId: facts.job.id });
    const accepted = await row(facts.job.id);
    expect(accepted).toMatchObject({
      state: "submitted",
      attemptNo: 1,
      externalJobId: "4000048858",
    });
    expect(submit).toHaveBeenCalledOnce();
    const before = await snapshot(facts),
      inbox = await receipts(facts.job.id);
    h.fake.asr.resetCalls();
    h.fake.storage.resetCalls();
    expect((await callback(facts, "4000048858")).ack.status).toBe(200);
    expect(await snapshot(facts)).toEqual(before);
    expect(await receipts(facts.job.id)).toEqual(inbox);
    h.clock.advance(accepted.nextRunAt.getTime() - h.clock.now().getTime());
    await h.media.jobs.run({ jobId: accepted.id });
    expect(h.fake.asr.callsOf("submit")).toHaveLength(0);
    expect(submit).toHaveBeenCalledOnce();
    expect(h.fake.asr.callsOf("query")).toHaveLength(1);
    expect(await row(accepted.id)).toMatchObject({
      state: "submitted",
      externalJobId: accepted.externalJobId,
    });
  });

  it("unknown job and old TaskId are ignored without provider calls", async () => {
    const facts = await ready();
    await ignored(facts, "18446744073709551615");
    const absent = uuidv7();
    expect(
      await h.tx.run((tx) => h.media.wakeAsrJob(tx, { mediaJobId: absent, externalJobId: "1" })),
    ).toBe("ignored");
    expect(await h.prisma.mediaJob.findUnique({ where: { id: absent } })).toBeNull();
    noIo();
  });

  it.each(["queued", "running", "submitting", "succeeded", "failed", "canceled"])(
    "%s state is immutable even when external ID and owner facts match",
    async (state) => {
      const facts = await ready();
      await changeJob(facts, {
        state,
        leaseOwner: "real-lease-fixture",
        output: { sentinel: "stored-result" },
        errorCode: "PREEXISTING",
        errorMessage: "local-error",
        finishedAt: ["succeeded", "failed", "canceled"].includes(state) ? h.clock.now() : null,
      });
      await ignored(facts);
    },
  );

  it("requires actual configured handler provider, remote mode, ASR kind and attempt", async () => {
    const changes: Prisma.MediaJobUpdateInput[] = [
      { provider: "asr" },
      { provider: "unconfigured" },
      { mode: "local" },
      { kind: "vision" },
      { attemptNo: 0 },
      { externalJobId: null },
    ];
    for (const change of changes) {
      const facts = await ready();
      await changeJob(facts, change);
      await ignored(facts);
    }
  });

  it("reuses canonical asset job ownership instead of trusting caller IDs", async () => {
    const changes: Prisma.MediaJobUpdateInput[] = [
      { parentType: "upload_batch" },
      { parentId: uuidv7() },
      { subjectType: "store_asset" },
      { subjectId: uuidv7() },
      { dedupeKey: `foreign:${uuidv7()}` },
      { input: {} },
    ];
    for (const change of changes) {
      const facts = await ready();
      await changeJob(facts, change);
      await ignored(facts);
    }
  });

  it("deadline equal to now or already expired cannot be revived", async () => {
    for (const delta of [0, -1]) {
      const facts = await ready();
      await changeJob(facts, { deadlineAt: new Date(h.clock.now().getTime() + delta) });
      await ignored(facts);
    }
  });

  it("processed, deleted and blocked parent assets remain immutable", async () => {
    const changes: Prisma.StoreAssetUpdateInput[] = [
      { processingState: "processed" },
      { deletedAt: new Date("2026-10-10T04:00:00Z") },
      { moderationState: "block" },
    ];
    for (const data of changes) {
      const facts = await ready();
      await h.prisma.storeAsset.update({ where: { id: facts.assetId }, data });
      await ignored(facts);
    }
  });

  it("missing real file link prevents wake despite the task's unchanged fingerprint", async () => {
    const facts = await ready();
    await h.prisma.storeAssetFile.delete({
      where: { storeAssetId_position: { storeAssetId: facts.assetId, position: 1 } },
    });
    await ignored(facts);
  });

  it("nonstored, blocked or wrong-category file facts prevent wake", async () => {
    const changes: Prisma.FileObjectUpdateInput[] = [
      { status: "deleting" },
      { moderationState: "block" },
    ];
    for (const data of changes) {
      const facts = await ready();
      await h.prisma.fileObject.update({ where: { id: facts.file.id }, data });
      await ignored(facts);
    }
    const facts = await ready();
    const portrait = await h.stored(h.owner, "portrait_auth");
    expect(portrait).toMatchObject({ status: "stored", category: "portrait_auth" });
    await replaceSourceFile(facts, portrait);
    await ignored(facts);
    expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: portrait.id } })).toEqual(
      portrait,
    );
  });

  it.each(["etag", "crc64", "sizeBytes"] as const)(
    "changed %s fingerprint is ignored",
    async (field) => {
      const facts = await ready();
      const data =
        field === "etag"
          ? { etag: '"changed-fingerprint"' }
          : field === "crc64"
            ? { crc64: "1" }
            : { sizeBytes: facts.file.sizeBytes! + 1n };
      await h.prisma.fileObject.update({ where: { id: facts.file.id }, data });
      await ignored(facts);
    },
  );

  it("a real foreign entity/store file stays forbidden even with matching task fingerprint", async () => {
    const facts = await ready();
    const merchant = await h.make.merchant({ verified: true });
    const actor = {
      identity: createIdentityContext({
        actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
      }),
      merchant: {
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
        standing: "owner" as const,
      },
    };
    const foreign = await h.stored(actor);
    await replaceSourceFile(facts, foreign);
    await ignored(facts);
    expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(
      foreign,
    );
  });

  it.each(["run", "prompt"] as const)(
    "a newer real %s generation invalidates the old callback",
    async (change) => {
      const facts = await ready();
      const input = AssetJobInputSchema.parse(facts.job.input);
      const fresh = {
        ...input,
        ...(change === "run" ? { runId: uuidv7() } : { promptVersion: input.promptVersion + 1 }),
      };
      await h.prisma.mediaJob.create({
        data: {
          id: uuidv7(),
          kind: "asr",
          provider: "fake",
          mode: "remote",
          parentType: "store_asset",
          parentId: facts.assetId,
          subjectType: "file_object",
          subjectId: facts.file.id,
          input: fresh,
          state: "queued",
          nextRunAt: h.clock.now(),
          deadlineAt: facts.job.deadlineAt,
          dedupeKey: `asset:${facts.assetId}:${fresh.runId}:asr:${facts.file.id}:v${fresh.promptVersion}`,
          createdAt: new Date(h.clock.now().getTime() + 1),
          updatedAt: h.clock.now(),
        },
      });
      await ignored(facts);
    },
  );

  it.each(["store_asset", "media_job", "file_object"] as const)(
    "waits on the real %s lock and rejects a committed stale winner",
    async (table) => {
      const facts = await ready();
      const locked = gate(),
        unlock = gate();
      const observer = await connectTestDatabase(database.name, { role: null });
      let blockerPid = 0;
      const blockedId =
        table === "store_asset"
          ? facts.assetId
          : table === "media_job"
            ? facts.job.id
            : facts.file.id;
      const blocker = h.tx.run(async (tx) => {
        await lockRows(tx, table, [blockedId]);
        blockerPid = (
          await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
        )[0]!.pid;
        locked.release();
        await unlock.promise;
        if (table === "store_asset")
          await tx.storeAsset.update({
            where: { id: facts.assetId },
            data: { moderationState: "block" },
          });
        else if (table === "media_job")
          await tx.mediaJob.update({
            where: { id: facts.job.id },
            data: { externalJobId: "18446744073709551615", updatedAt: facts.job.updatedAt },
          });
        else
          await tx.fileObject.update({
            where: { id: facts.file.id },
            data: { etag: '"lock-winner"' },
          });
      });
      let running: ReturnType<typeof callback> | undefined;
      try {
        await Promise.race([
          locked.promise,
          blocker.then(() => {
            throw new Error("lock session exited early");
          }),
        ]);
        running = callback(facts);
        void running.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const blocked = await observer.query<{ count: string }>(
              `
            SELECT count(*)::bigint AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE $2 AND $1=ANY(pg_blocking_pids(pid))`,
              [blockerPid, `%${table}%`],
            );
            expect(Number(blocked.rows[0]!.count)).toBeGreaterThan(0);
          },
          { timeout: 3000 },
        );
        expect(await row(facts.job.id)).toEqual(facts.job);
        noIo();
      } finally {
        unlock.release();
        try {
          await blocker;
          await running;
        } finally {
          await observer.end();
        }
      }
      const winner = await snapshot(facts);
      expect(winner.job.nextRunAt).toEqual(facts.job.nextRunAt);
      expect(winner.job.updatedAt).toEqual(facts.job.updatedAt);
      expect(await receipts(facts.job.id)).toEqual([
        expect.objectContaining({ processState: "ignored", payload: null }),
      ]);
      noIo();
    },
  );

  it("parent candidate is read again after waiting; reparented jobs cannot use the old lock", async () => {
    const facts = await ready(),
      other = await ready();
    const locked = gate(),
      unlock = gate();
    const observer = await connectTestDatabase(database.name, { role: null });
    let blockerPid = 0;
    const blocker = h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [facts.assetId]);
      blockerPid = (
        await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
      )[0]!.pid;
      locked.release();
      await unlock.promise;
      await lockRows(tx, "media_job", [facts.job.id]);
      await tx.mediaJob.update({
        where: { id: facts.job.id },
        data: { parentId: other.assetId, updatedAt: facts.job.updatedAt },
      });
    });
    let running: ReturnType<typeof callback> | undefined;
    try {
      await Promise.race([
        locked.promise,
        blocker.then(() => {
          throw new Error("parent session exited early");
        }),
      ]);
      running = callback(facts);
      void running.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const blocked = await observer.query<{ count: string }>(
            `
          SELECT count(*)::bigint AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%store_asset%' AND $1=ANY(pg_blocking_pids(pid))`,
            [blockerPid],
          );
          expect(Number(blocked.rows[0]!.count)).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
    } finally {
      unlock.release();
      try {
        await blocker;
        await running;
      } finally {
        await observer.end();
      }
    }
    expect(await row(facts.job.id)).toEqual({ ...facts.job, parentId: other.assetId });
    expect(await receipts(facts.job.id)).toEqual([
      expect.objectContaining({ processState: "ignored" }),
    ]);
    noIo();
  });

  it("failure after the real owner update rolls back both task and inbox atomically", async () => {
    const facts = await ready(),
      before = await snapshot(facts);
    const hooks = receiver(
      source(async (tx: Tx, input) => {
        expect(await h.media.wakeAsrJob(tx, input)).toBe("processed");
        throw new Error("fictional-private-db-failure");
      }),
    );
    const { ack } = await callback(facts, facts.job.externalJobId!, hooks);
    expect(ack).toMatchObject({ status: 500, body: '{"code":1,"message":"failure"}' });
    expect(await snapshot(facts)).toEqual(before);
    expect(await receipts(facts.job.id)).toEqual([]);
    noIo();
  });
});
