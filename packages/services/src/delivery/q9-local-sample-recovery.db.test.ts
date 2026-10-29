import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import { uuidv7 } from "../kernel/index.js";
import { createConfig, createConfigAdmin } from "../config/index.js";
import { staffBriefs } from "../staff/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { draft } from "./__fixtures__/harness.js";
import { productionHarness } from "./__fixtures__/production-tools.js";
import type { ProductionHarness } from "./__fixtures__/production-tools.js";
import {
  createQ9LocalSampleRecovery,
  Q9LocalSampleRecoveryInputSchema,
  q9LocalSampleRecoveryEnv,
} from "../index.js";

const db = useSeededDatabase("services", { label: "q9dry" });
let h: ProductionHarness;
beforeAll(async () => {
  h = productionHarness(await db.prisma());
});
afterAll(async () => {
  await h?.close();
});

async function legacy() {
  const order = await h.order(true, 1, undefined, 2);
  const editor = await h.staff();
  const reviewer = await h.staff();
  const item = order.items[0]!;
  await h.prisma.drama.update({ where: { id: item.dramaId }, data: { isAiGenerated: false } });
  await h.delivery.replaceDraft(editor.ctx, editor.staff, order.deliveryPlanId, {
    draftLockVersion: 0,
    content: draft(order),
  });
  await h.delivery.push(editor.ctx, editor.staff, order.deliveryPlanId, { draftLockVersion: 1 });
  await h.delivery.confirm(order.viewer, order.deliveryPlanId, { versionNo: 1 });
  await h.master(item.dramaId, 1, editor.row.id);
  const actor = { identity: editor.ctx, staff: editor.staff };
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const registered = await h.media.register(actor, {
    category: "sample_video",
    storeId: order.store.id,
    production: {
      kind: "sample",
      orderItemId: item.id,
      episodeNo: 1,
      aiUsage: { used: false, tools: [] },
    },
    files: [
      { fileName: "legacy-dry-run.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() },
    ],
  });
  const file = registered.items[0]!;
  h.fake.storage.put({ bucket: "media", key: file.key }, bytes, "video/mp4");
  await h.media.completeAdmin(actor, file.fileId);
  const job = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await h.media.promote({ jobId: job.id });
  await h.finish(file.fileId, true);
  const created = await h.delivery.sampleCreate(
    editor.ctx,
    editor.staff,
    order.deliveryTicketIds[0]!,
    {
      fileId: file.fileId,
      adSlots: [],
    },
  );
  const template = await h.prisma.checklistTemplate.findFirstOrThrow({
    where: { code: "qc.sample", status: "active" },
  });
  const quality = {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map((entry) => ({
      key: entry.key,
      result: "pass" as const,
    })),
  };
  await h.delivery.sampleInspect(reviewer.ctx, reviewer.staff, created.sampleId, quality);
  await h.delivery.samplePush(reviewer.ctx, reviewer.staff, created.sampleId, {});
  // Historical rows are created only inside the isolated test fixture.
  const source = await h.prisma.sample.update({
    where: { id: created.sampleId },
    data: { previewChannels: ["album", "portal"] },
  });
  await h.prisma.featureFlag.update({
    where: { key: "weapp.video.sample.enabled" },
    data: { defaultValue: false, rules: [], lockVersion: { increment: 1 } },
  });
  return { order, reviewer, source, quality };
}

async function snapshot() {
  return {
    flag: await h.prisma.featureFlag.findUnique({ where: { key: "weapp.video.sample.enabled" } }),
    samples: await h.prisma.sample.findMany({ orderBy: { id: "asc" } }),
    tickets: await h.prisma.deliveryTicket.findMany({ orderBy: { id: "asc" } }),
    stages: await h.prisma.deliveryTicketStage.findMany({ orderBy: { id: "asc" } }),
    qc: await h.prisma.qcRecord.count(),
    audit: await h.prisma.auditLog.count(),
    history: await h.prisma.statusTransition.count(),
    events: await h.prisma.outboxEvent.count(),
    refs: await h.prisma.fileRef.count(),
    idem: await h.prisma.idempotencyRecord.count(),
    mediaJobs: await h.prisma.mediaJob.findMany({ orderBy: { id: "asc" } }),
  };
}

it("默认dry-run及规则关闭时零写；成功恢复后关闭规则仍可同键零写重放", async () => {
  const { order, reviewer, source, quality } = await legacy();
  const updateFlag = vi.fn();
  const invalidate = vi.fn();
  const isEnabled = vi.fn();
  // Only the CLI's declaration uses public local URLs. Every actual query uses h.tx,
  // which is bound to useSeededDatabase's guarded lyx_test_ database; no local business DB is opened.
  const runtime = {
    env: q9LocalSampleRecoveryEnv({
      APP_ENV: "local",
      DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/liyoxi",
      REDIS_URL: "redis://127.0.0.1:6389/0",
      MINIO_ENDPOINT: "http://127.0.0.1:9100",
      MINIO_PUBLIC_ENDPOINT: "http://127.0.0.1:9100",
      LYX_Q9_MEDIA_WORK_DIR: "/work",
      LYX_Q9_MEDIA_SOCKET: "/work/.sock/mediatool.sock",
    }),
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    flow: h.flow,
    events: h.events,
    media: h.media,
    providers: { storage: { status: "local" } },
    configAdmin: { updateFlag },
    config: { cache: { invalidate }, flags: { isEnabled } },
  } as unknown as Parameters<typeof createQ9LocalSampleRecovery>[0];
  const input = Q9LocalSampleRecoveryInputSchema.parse({
    storeId: order.store.id,
    sampleId: source.id,
    versionNo: source.versionNo,
    staffId: reviewer.row.id,
    configStaffId: reviewer.row.id,
    reason: "隔离测试仅预检历史样片不执行恢复",
    quality,
    idempotencyKey: "q9-default-dry-run",
  });
  expect(input.apply).toBe(false);
  h.fake.storage.resetCalls();
  h.fake.media.resetCalls();
  const before = await snapshot();
  const actions = createQ9LocalSampleRecovery(runtime);
  expect(await actions.run(input)).toMatchObject({
    mode: "dry-run",
    canApply: true,
    blockers: [],
    idempotentReplay: false,
    sample: {
      sampleId: source.id,
      status: "pushed",
      versionNo: 1,
      previewChannels: ["album", "portal"],
    },
    flag: {
      currentDefaultValue: false,
      proposedDefaultValue: true,
      willEnable: true,
      rulesPreserved: true,
    },
  });
  expect(await snapshot()).toEqual(before);
  expect(updateFlag).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(isEnabled).not.toHaveBeenCalled();
  expect(h.fake.storage.calls).toEqual([]);
  expect(h.fake.media.calls).toEqual([]);

  await h.prisma.featureFlag.update({
    where: { key: "weapp.video.sample.enabled" },
    data: {
      rules: [{ when: { entityIds: [order.entity.id] }, value: false }],
      lockVersion: { increment: 1 },
    },
  });
  const blockedBefore = await snapshot();
  expect(await actions.run({ ...input, apply: true })).toMatchObject({
    mode: "apply",
    canApply: false,
    blockers: ["FLAG_RULE_STILL_DISABLED"],
  });
  expect(await snapshot()).toEqual(blockedBefore);
  expect(updateFlag).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(h.fake.storage.calls).toEqual([]);

  // Restore only this test's fixture, then exercise the real audited configuration writer.
  await h.prisma.featureFlag.update({
    where: { key: "weapp.video.sample.enabled" },
    data: { rules: [], lockVersion: { increment: 1 } },
  });
  const config = createConfig({ db: h.prisma, clock: h.clock, redis: null });
  const configAdmin = createConfigAdmin({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    config,
    staffBriefs,
  });
  const realFlagWrite = vi.spyOn(configAdmin, "updateFlag");
  const cacheBump = vi.spyOn(config.cache, "bump");
  Object.assign(runtime, { config, configAdmin });
  const applied = await actions.run({ ...input, apply: true });
  expect(applied).toMatchObject({
    mode: "applied",
    flagCommitted: true,
    versionNo: 2,
    status: "pushed",
    replayed: false,
    merchantConfirmation: "pending",
  });
  expect(realFlagWrite).toHaveBeenCalledTimes(1);
  expect(cacheBump).toHaveBeenCalledExactlyOnceWith("flag");
  await h.prisma.featureFlag.update({
    where: { key: "weapp.video.sample.enabled" },
    data: {
      rules: [{ when: { entityIds: [order.entity.id] }, value: false }],
      lockVersion: { increment: 1 },
    },
  });
  config.cache.invalidate("flag");
  expect(
    await config.flags.isEnabled("weapp.video.sample.enabled", { entityId: order.entity.id }),
  ).toBe(false);
  const replayBefore = await snapshot();
  h.fake.storage.resetCalls();
  h.fake.media.resetCalls();
  expect(await actions.run({ ...input, apply: true })).toEqual({
    ...applied,
    flagCommitted: false,
    replayed: true,
  });
  expect(await snapshot()).toEqual(replayBefore);
  expect(realFlagWrite).toHaveBeenCalledTimes(1);
  expect(cacheBump).toHaveBeenCalledTimes(1);
  expect(h.fake.storage.calls).toEqual([]);
  expect(h.fake.media.calls).toEqual([]);
}, 60_000);
