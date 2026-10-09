import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import { uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { draft } from "./__fixtures__/harness.js";
import { productionHarness } from "./__fixtures__/production-tools.js";
import type { ProductionHarness } from "./__fixtures__/production-tools.js";

const db = useSeededDatabase("services");
let h: ProductionHarness;
beforeAll(async () => {
  h = productionHarness(await db.prisma());
});
afterAll(async () => {
  await h?.close();
});
async function setup(ai = false) {
  const o = await h.order(true, 1, undefined, 2),
    editor = await h.staff(),
    qc = await h.staff();
  await h.prisma.drama.update({
    where: { id: o.items[0]!.dramaId },
    data: { synopsis: "制作订阅虚构短剧", isAiGenerated: ai },
  });
  await h.delivery.replaceDraft(editor.ctx, editor.staff, o.deliveryPlanId, {
    draftLockVersion: 0,
    content: draft(o),
  });
  await h.delivery.push(editor.ctx, editor.staff, o.deliveryPlanId, { draftLockVersion: 1 });
  await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 });
  await h.master(o.items[0]!.dramaId, 1, editor.row.id);
  const actor = { identity: editor.ctx, staff: editor.staff },
    bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const registered = await h.media.register(actor, {
    category: "sample_video",
    storeId: o.store.id,
    production: {
      kind: "sample",
      orderItemId: o.items[0]!.id,
      episodeNo: 1,
      aiUsage: { used: ai, tools: [] },
    },
    files: [{ fileName: "checked.mp4", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
  });
  const f = registered.items[0]!;
  h.fake.storage.put({ bucket: "media", key: f.key }, bytes, "video/mp4");
  await h.media.completeAdmin(actor, f.fileId);
  const promote = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${f.fileId}` },
  });
  await h.media.promote({ jobId: promote.id });
  return {
    o,
    editor,
    qc,
    fileId: f.fileId,
    ticketId: o.deliveryTicketIds[0]!,
    body: { fileId: f.fileId, adSlots: [] },
  };
}
async function sample(input: Awaited<ReturnType<typeof setup>>) {
  return h.delivery.sampleCreate(input.editor.ctx, input.editor.staff, input.ticketId, input.body);
}
async function checks() {
  const template = await h.prisma.checklistTemplate.findFirstOrThrow({
    where: { code: "qc.sample", status: "active" },
  });
  return {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
      key,
      result: "pass" as const,
    })),
  };
}
async function restamp(fileId: string) {
  return h.prisma.mediaJob.findFirstOrThrow({ where: { kind: "restamp", subjectId: fileId } });
}
describe("delivery.onProductionChecked真实当前事实", { timeout: 60_000 }, () => {
  it("pass双连接重复只回写真实时长，不能生成QC或推送；伪造payload不能代替probe", async () => {
    const f = await setup(),
      s = await sample(f);
    await h.consume({
      id: uuidv7(),
      type: "media.production.checked",
      payload: {
        v: 1,
        fileId: f.fileId,
        kind: "sample",
        orderItemId: f.o.items[0]!.id,
        gate: "pass",
        durationMs: 999,
      },
    });
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "uploaded",
      durationMs: null,
    });
    await h.probe(f.fileId);
    const event = await h.checked(f.fileId),
      before = await h.tx.run((tx) => h.counts(tx, s.sampleId));
    await Promise.all([h.consume(event), h.consume(event)]);
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "uploaded",
      durationMs: 60_000,
      qcRecordId: null,
    });
    expect(await h.tx.run((tx) => h.counts(tx, s.sampleId))).toEqual(before);
    expect(await h.prisma.qcRecord.count({ where: { targetId: s.sampleId } })).toBe(0);
    await expect(h.delivery.samplePush(f.qc.ctx, f.qc.staff, s.sampleId, {})).rejects.toMatchObject(
      { error: "STATE_NOT_ALLOWED" },
    );
  });
  it("真实reject双连接只迁移一次，释放引用保留30d；晚结果不改新版本", async () => {
    const f = await setup(),
      first = await sample(f),
      newer = await sample(f);
    const record = await h.prisma.productionRecord.findUniqueOrThrow({
      where: { fileId: f.fileId },
    });
    // Current master becomes absent: the actual probe's H0 result is reject, never a fabricated event gate.
    await h.prisma.dramaEpisodeMaster.update({
      where: { id: record.dramaEpisodeMasterId! },
      data: { isCurrent: false },
    });
    await h.prisma.mediaInfo.delete({
      where: {
        fileId: (
          await h.prisma.dramaEpisodeMaster.findUniqueOrThrow({
            where: { id: record.dramaEpisodeMasterId! },
          })
        ).fileId,
      },
    });
    await h.probe(f.fileId);
    const event = await h.checked(f.fileId);
    await Promise.all([h.consume(event), h.consume(event)]);
    expect(
      await h.prisma.sample.findUniqueOrThrow({ where: { id: first.sampleId } }),
    ).toMatchObject({ status: "superseded" });
    expect(
      await h.prisma.sample.findUniqueOrThrow({ where: { id: newer.sampleId } }),
    ).toMatchObject({ status: "check_rejected" });
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: newer.sampleId, event: "sample.check_rejected" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: newer.sampleId, eventType: "sample.check_rejected" },
      }),
    ).toBe(1);
    const ref = await h.prisma.fileRef.findFirstOrThrow({
      where: { fileId: f.fileId, refType: "sample", refId: newer.sampleId },
    });
    expect(ref).toMatchObject({
      state: "released",
      keepUntil: new Date(h.clock.now().getTime() + 30 * 86_400_000),
    });
    const winner = await h.prisma.sample.findUniqueOrThrow({ where: { id: newer.sampleId } });
    await h.consume({ ...event, payload: { ...event.payload, gate: "pass" } });
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: newer.sampleId } })).toEqual(
      winner,
    );
  });
  it("创建前已reject但真实补标在途仅可uploaded；pending不能QC且不伪写ready", async () => {
    const f = await setup(true);
    await h.probe(f.fileId);
    const before = await h.prisma.productionRecord.findUniqueOrThrow({
      where: { fileId: f.fileId },
    });
    expect(before.pipelineState).toBe("rejected");
    expect((await restamp(f.fileId)).state).toBe("queued");
    const s = await sample(f);
    await h.consume(await h.checked(f.fileId));
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "uploaded",
      fileId: f.fileId,
    });
    expect(
      await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: f.fileId } }),
    ).toEqual(before);
    await expect(
      h.delivery.sampleInspect(f.qc.ctx, f.qc.staff, s.sampleId, await checks()),
    ).rejects.toMatchObject({ error: "PRODUCTION_NOT_READY" });
  });
  it("实际补标+派生probe pass才替换uploaded引用，保上传人/双人QC/30d；原reject乱序到达不先拒收", async () => {
    const f = await setup(true),
      s = await sample(f);
    await h.probe(f.fileId);
    const originalEvent = await h.checked(f.fileId),
      task = await restamp(f.fileId);
    await h.media.jobs.run({ jobId: task.id });
    const completed = await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: task.id } });
    expect(completed.state).toBe("succeeded");
    const derivedId = (completed.output as { fileId: string }).fileId;
    await h.consume(originalEvent);
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "uploaded",
      fileId: f.fileId,
    });
    await h.probe(derivedId);
    await h.consume(originalEvent);
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "uploaded",
      fileId: f.fileId,
    });
    const event = await h.checked(derivedId);
    await Promise.all([h.consume(event), h.consume(event)]);
    const adopted = await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } });
    expect(adopted).toMatchObject({
      status: "uploaded",
      fileId: derivedId,
      durationMs: 60_000,
      uploadedByStaffId: f.editor.row.id,
      qcRecordId: null,
    });
    expect(
      await h.prisma.fileRef.findFirstOrThrow({
        where: { fileId: f.fileId, refType: "sample", refId: s.sampleId },
      }),
    ).toMatchObject({
      state: "released",
      keepUntil: new Date(h.clock.now().getTime() + 30 * 86_400_000),
    });
    expect(
      await h.prisma.fileRef.count({
        where: { fileId: derivedId, refType: "sample", refId: s.sampleId, state: "live" },
      }),
    ).toBe(1);
    await h.consume(originalEvent);
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toEqual(adopted);
    await expect(
      h.delivery.sampleInspect(f.editor.ctx, f.editor.staff, s.sampleId, await checks()),
    ).rejects.toMatchObject({ error: "QC_SELF_INSPECTION" });
    expect(await h.prisma.qcRecord.count({ where: { targetId: s.sampleId } })).toBe(0);
  });
  it("先pending后补标失败无新checked触发时仍not-ready；重放原reject才拒收，失败文件不能新建uploaded", async () => {
    const f = await setup(true),
      s = await sample(f);
    await h.probe(f.fileId);
    const event = await h.checked(f.fileId);
    await h.consume(event);
    h.failStamp(true);
    try {
      await h.media.jobs.run({ jobId: (await restamp(f.fileId)).id });
    } finally {
      h.failStamp(false);
    }
    expect((await restamp(f.fileId)).state).toBe("failed");
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "uploaded",
      fileId: f.fileId,
    });
    await expect(
      h.delivery.sampleInspect(f.qc.ctx, f.qc.staff, s.sampleId, await checks()),
    ).rejects.toMatchObject({ error: "PRODUCTION_NOT_READY" });
    await expect(sample(f)).rejects.toMatchObject({ error: "PRODUCTION_NOT_READY" });
    await h.consume(event);
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toMatchObject({
      status: "check_rejected",
    });
  });
  it("订阅收尾异常全部回滚，重放后再一次拒收；跨order/context载荷零写", async () => {
    const f = await setup(true),
      s = await sample(f);
    await h.probe(f.fileId);
    const event = await h.checked(f.fileId),
      task = await restamp(f.fileId);
    await h.prisma.mediaJob.update({
      where: { id: task.id },
      data: { state: "canceled", finishedAt: h.clock.now() },
    });
    const before = await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } });
    await h.consume({ ...event, payload: { ...event.payload, orderItemId: uuidv7() } });
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toEqual(before);
    const { createProductionChecked } = await import("./production-checked.js");
    const run = createProductionChecked({ clock: h.clock, flow: h.flow, media: h.media });
    await expect(
      h.tx.run(async (tx) => {
        await run(tx, event);
        throw new Error("rollback marker");
      }),
    ).rejects.toThrow("rollback marker");
    expect(await h.prisma.sample.findUniqueOrThrow({ where: { id: s.sampleId } })).toEqual(before);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: s.sampleId, event: "sample.check_rejected" },
      }),
    ).toBe(0);
    await h.consume(event);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: s.sampleId, event: "sample.check_rejected" },
      }),
    ).toBe(1);
  });
  it("真实checked事件排列与重复不回退旧版本，只采用当前派生且不自动QC", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }),
        async (order) => {
          // Each round has its own valid DB facts; codec doubles never stand for native rendering.
          const f = await setup(true),
            old = await sample(f),
            current = await sample(f);
          const oldRow = await h.prisma.sample.findUniqueOrThrow({ where: { id: old.sampleId } });
          expect(oldRow.status).toBe("superseded");
          await h.probe(f.fileId);
          const original = await h.checked(f.fileId),
            task = await restamp(f.fileId);
          await h.media.jobs.run({ jobId: task.id });
          const completed = await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: task.id } });
          expect(completed.state).toBe("succeeded");
          const derivedId = (completed.output as { fileId: string }).fileId;
          await h.probe(derivedId);
          const derived = await h.checked(derivedId);
          const wrong = {
            ...derived,
            id: uuidv7(),
            payload: { ...derived.payload, orderItemId: uuidv7() },
          };
          const events = [original, derived, derived, wrong];
          const before = await h.tx.run((tx) => h.counts(tx, current.sampleId));
          let adopted: typeof oldRow | undefined;
          for (const index of order) {
            await h.consume(events[index]!);
            const now = await h.prisma.sample.findUniqueOrThrow({
              where: { id: current.sampleId },
            });
            if (adopted) expect(now).toEqual(adopted);
            if (index === 1 || index === 2) adopted = now;
            expect(
              await h.prisma.sample.findUniqueOrThrow({ where: { id: old.sampleId } }),
            ).toEqual(oldRow);
            expect(now).toMatchObject({
              status: "uploaded",
              uploadedByStaffId: f.editor.row.id,
              qcRecordId: null,
            });
          }
          expect(adopted).toMatchObject({ fileId: derivedId, durationMs: 60_000 });
          expect(
            await h.prisma.fileRef.count({
              where: {
                fileId: derivedId,
                refType: "sample",
                refId: current.sampleId,
                state: "live",
              },
            }),
          ).toBe(1);
          expect(
            await h.prisma.fileRef.findFirstOrThrow({
              where: { fileId: f.fileId, refType: "sample", refId: current.sampleId },
            }),
          ).toMatchObject({
            state: "released",
            keepUntil: new Date(h.clock.now().getTime() + 30 * 86_400_000),
          });
          expect(await h.tx.run((tx) => h.counts(tx, current.sampleId))).toEqual(before);
          expect(await h.prisma.qcRecord.count({ where: { targetId: current.sampleId } })).toBe(0);
        },
      ),
      { numRuns: 8, endOnFailure: true },
    );
  });
});
