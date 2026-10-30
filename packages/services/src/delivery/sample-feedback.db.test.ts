import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS, SampleRequestChangeBodySchema } from "@liyoxi/contract";
import { addDays, atMinuteOfDay, calendarDate } from "@liyoxi/shared/time";
import { ownTaskScope } from "../authz/index.js";
import {
  AppError,
  createIdempotencyContext,
  createIdentityContext,
  remindersOf,
  uuidv7,
} from "../kernel/index.js";
import type { IdentityContext } from "../kernel/index.js";
import type { MediaActor } from "../media/index.js";
import { notificationFixture, useSeededDatabase } from "../testing/index.js";
import { holdCancelReviewPauses, readCancelReviewHoldTargets } from "./index.js";
import {
  cancellationCause,
  checks,
  confirmedPlacementAd,
  m5Harness,
  prepared,
  productionFile,
} from "./__fixtures__/m5.js";
import type { M5Harness, M5Order } from "./__fixtures__/m5.js";

const db = useSeededDatabase("services");
let h: M5Harness;
let notices: ReturnType<typeof notificationFixture>;
beforeAll(async () => {
  const prisma = await db.prisma();
  h = m5Harness(prisma);
  notices = notificationFixture(prisma);
});
afterAll(async () => {
  await notices?.service.close();
  await h?.close();
});

async function sample(
  pushed = true,
  withAd = false,
  beforeProduction?: (o: M5Order) => Promise<void>,
) {
  const f = await prepared(
    h,
    false,
    withAd ? (o, editor) => confirmedPlacementAd(h, o, editor) : undefined,
  );
  await beforeProduction?.(f.o);
  const fileId = await productionFile(h, f.o, f.editor, "sample_video"),
    s = await h.delivery.sampleCreate(f.editor.ctx, f.editor.staff, f.id, {
      fileId,
      adSlots: [],
    });
  await h.delivery.sampleInspect(f.qc.ctx, f.qc.staff, s.sampleId, await checks(h, "qc.sample"));
  if (pushed) await h.delivery.samplePush(f.qc.ctx, f.qc.staff, s.sampleId, {});
  return { ...f, sampleId: s.sampleId, fileId };
}

async function attachment(
  o: M5Order,
  category: "ticket_attachment" | "profile_image" = "ticket_attachment",
  stored = true,
) {
  const actor: MediaActor = {
      identity: o.viewer.ctx,
      merchant: { standing: "owner", entityId: o.entity.id, storeId: o.store.id },
    },
    bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    registered = await h.media.register(actor, {
      category,
      files: [{ fileName: "feedback.png", sizeBytes: String(bytes.length), clientToken: uuidv7() }],
    }),
    file = registered.items[0]!;
  if (stored) {
    h.fake.storage.put({ bucket: "asset", key: file.key }, bytes, "image/png");
    await h.media.complete(actor, file.fileId);
    const job = await h.prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${file.fileId}` },
    });
    await h.media.promote({ jobId: job.id });
  }
  return file.fileId;
}

async function snapshot(sampleId: string, ticketId: string) {
  return {
    sample: await h.prisma.sample.findUniqueOrThrow({ where: { id: sampleId } }),
    ticket: await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    history: await h.prisma.statusTransition.count(),
    events: await h.prisma.outboxEvent.count(),
    audit: await h.prisma.auditLog.count(),
    refs: await h.prisma.fileRef.count(),
    stages: await h.prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: ticketId },
      orderBy: { id: "asc" },
    }),
    timers: await h.prisma.timer.findMany({ orderBy: { id: "asc" } }),
    holds: await h.prisma.pointHold.findMany({ orderBy: { id: "asc" } }),
    ledger: await h.prisma.pointLedgerEntry.count(),
  };
}

function idem(
  scope: string,
  actor: IdentityContext["actor"],
  sampleId: string,
  body: unknown,
  key = uuidv7(),
) {
  return () =>
    createIdempotencyContext({
      mode: "required",
      scope,
      actor,
      key,
      request: { method: "POST", pathParams: { sampleId }, body },
      redact:
        scope === "m.sample.requestChange"
          ? ["playable", "decision.feedbackImages[].url", "decision.feedbackImages[].expiresAt"]
          : ["preview"],
    });
}

describe("商家样片反馈与独立发送登记", { timeout: 60_000 }, () => {
  it("截图上传按精确工单/样片/广告能力判权，无成员上下文与店员零登记；停用老板可用工单收尾能力", async () => {
    const o = await h.order(true),
      user = await h.make.merchantUser(),
      member = await h.make.entityMember({ entityId: o.entity.id, merchantUserId: user.id });
    await h.make.storeMember({
      entityMemberId: member.id,
      storeId: o.store.id,
      addedByMemberId: o.member.id,
    });
    const actor: MediaActor = {
        identity: o.viewer.ctx,
        merchant: { standing: "owner", entityId: o.entity.id, storeId: o.store.id },
      },
      clerk: MediaActor = {
        identity: createIdentityContext({
          actor: { type: "merchant", id: user.id, client: "weapp", role: "clerk" },
          entityId: o.entity.id,
          storeId: o.store.id,
        }),
        merchant: { ...actor.merchant!, standing: "clerk" },
      },
      body = {
        category: "ticket_attachment" as const,
        files: [{ fileName: "feedback.png", sizeBytes: "8", clientToken: uuidv7() }],
      },
      before = await h.prisma.fileObject.count();
    await expect(h.media.register({ identity: actor.identity }, body)).rejects.toMatchObject({
      error: "FILE_CATEGORY_NOT_ALLOWED",
    });
    await expect(h.media.register(clerk, body)).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    expect(await h.prisma.fileObject.count()).toBe(before);
    const registered = await h.media.register(
        { ...actor, merchant: { ...actor.merchant!, standing: "archivedOwner" } },
        body,
      ),
      file = await h.prisma.fileObject.findUniqueOrThrow({
        where: { id: registered.items[0]!.fileId },
      });
    expect(file).toMatchObject({
      category: "ticket_attachment",
      status: "pending",
      storeId: o.store.id,
      uploadActorId: o.user.id,
    });
  });

  it("严格compose契约去空白，拒绝时间点、广告、版本、未知字段与重复/过量截图", () => {
    const base = { feedbackKind: "compose", note: "  调整字幕  " },
      fileId = uuidv7();
    expect(SampleRequestChangeBodySchema.parse(base).note).toBe("调整字幕");
    for (const body of [
      { ...base, feedbackKind: "ad_content" },
      { ...base, note: "  " },
      { ...base, note: "字".repeat(201) },
      { ...base, feedbackTimeMs: 100 },
      { ...base, feedback_time_ms: 100 },
      { ...base, adId: fileId },
      { ...base, versionNo: 1 },
      { ...base, unknown: true },
      { ...base, imageFileIds: [fileId, fileId] },
      { ...base, imageFileIds: Array.from({ length: 4 }, () => uuidv7()) },
    ])
      expect(SampleRequestChangeBodySchema.safeParse(body).success).toBe(false);
  });

  it("真实推送→compose同事务写决定/引用/轮次/新SLA，同key重放不增账；新样片可确认", async () => {
    let earlierFileId = "";
    const f = await sample(true, true, async (o) => {
        earlierFileId = await attachment(o);
      }),
      fileIds = [earlierFileId, await attachment(f.o), await attachment(f.o)].reverse(),
      body = {
        feedbackKind: "compose" as const,
        note: "  字幕靠下遮挡，请上移  ",
        imageFileIds: fileIds,
      },
      key = idem("m.sample.requestChange", f.o.viewer.ctx.actor, f.sampleId, body),
      before = await snapshot(f.sampleId, f.id),
      ad = await h.prisma.ad.findUniqueOrThrow({ where: { id: f.placement!.ad.id } }),
      result = await h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, body, { idem: key() });
    expect(earlierFileId < f.fileId).toBe(true);
    expect(result).toMatchObject({
      sampleId: f.sampleId,
      status: "change_requested",
      ticketStep: "sample_making",
      sampleRoundNo: before.ticket.sampleRoundNo + 1,
      decision: {
        feedbackKind: "compose",
        feedbackNote: "字幕靠下遮挡，请上移",
        isOnBehalf: false,
      },
    });
    expect(result.decision!.feedbackImages).toHaveLength(3);
    expect(result.decision!.feedbackImages.every((image) => !!image.url)).toBe(true);
    const after = await snapshot(f.sampleId, f.id),
      stage = after.stages.find((row) => row.completedAt === null)!;
    expect(after.sample).toMatchObject({
      status: "change_requested",
      decidedByUserId: f.o.user.id,
      decideClient: "weapp",
      feedbackFileIds: fileIds,
      feedbackTimeMs: null,
      onBehalfStaffId: null,
      firstViewedAt: null,
      viewedAckAt: null,
    });
    expect(stage).toMatchObject({ step: "sample_making", visitNo: 2 });
    expect(stage.dueAt).not.toBeNull();
    expect(after.ticket).toMatchObject({ stepDueAt: stage.dueAt, waitingOn: "staff" });
    expect(after.stages.find((row) => row.step === "sample_confirm")).toMatchObject({
      completedAt: h.clock.now(),
      exitEvent: "sample.change_requested",
    });
    expect(
      after.timers.filter((row) => row.subjectId === stage.id && row.status === "scheduled"),
    ).toEqual([expect.objectContaining({ kind: "sla.breach", fireAt: stage.dueAt })]);
    expect(after.holds).toEqual(before.holds);
    expect(after.ledger).toBe(before.ledger);
    expect(await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } })).toEqual(ad);
    expect(
      await h.prisma.fileRef.findMany({
        where: { refType: "sample", refId: f.sampleId, role: "feedback" },
      }),
    ).toHaveLength(3);
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "sample.change_requested", aggregateId: f.sampleId },
    });
    expect(EVENT_PAYLOAD_SCHEMAS["sample.change_requested"].parse(event.payload)).toMatchObject({
      sampleId: f.sampleId,
      deliveryTicketId: f.id,
      dramaOrderId: f.o.order.id,
      versionNo: 1,
      feedbackKind: "compose",
      fromState: "pushed",
      toState: "change_requested",
      transition: "sample.change_requested",
    });
    const replay = await h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, body, {
      idem: key(),
    });
    expect(replay).toMatchObject({ replayed: true, playable: null });
    expect(
      replay.decision!.feedbackImages.every(
        (image) => image.url === null && image.expiresAt === null,
      ),
    ).toBe(true);
    expect(await snapshot(f.sampleId, f.id)).toEqual(after);
    const nextFile = await productionFile(h, f.o, f.editor, "sample_video"),
      next = await h.delivery.sampleCreate(f.editor.ctx, f.editor.staff, f.id, {
        fileId: nextFile,
        adSlots: [],
      });
    await h.delivery.sampleInspect(
      f.qc.ctx,
      f.qc.staff,
      next.sampleId,
      await checks(h, "qc.sample"),
    );
    await h.delivery.samplePush(f.qc.ctx, f.qc.staff, next.sampleId, {});
    await expect(
      h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, body),
    ).rejects.toMatchObject({ error: "SAMPLE_VERSION_STALE" });
    await h.delivery.sampleConfirm(f.o.viewer, next.sampleId, {
      versionNo: 2,
      viewedVia: "weapp",
      hasViewed: true,
    });
    expect(await h.prisma.deliveryTicket.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      step: "batch_compose",
      sampleRoundNo: before.ticket.sampleRoundNo + 1,
    });
  });

  it("截图未入库、拦截、错误分类/门店/用户均零副作用，后置失败回滚整个反馈事务", async () => {
    const f = await sample(),
      usable = await attachment(f.o),
      pending = await attachment(f.o, "ticket_attachment", false),
      blocked = await attachment(f.o),
      wrongCategory = await attachment(f.o, "profile_image"),
      other = await h.order(true),
      wrongScope = await attachment(other),
      wrongUser = await attachment(f.o),
      anotherUser = await h.make.merchantUser();
    await h.prisma.fileObject.update({
      where: { id: blocked },
      data: { moderationState: "block" },
    });
    await h.prisma.fileObject.update({
      where: { id: wrongUser },
      data: { uploadActorId: anotherUser.id },
    });
    const before = await snapshot(f.sampleId, f.id);
    for (const bad of [pending, blocked, wrongCategory, wrongScope, wrongUser]) {
      await expect(
        h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, {
          feedbackKind: "compose",
          note: "请修改字幕",
          imageFileIds: [usable, bad],
        }),
      ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
      expect(await snapshot(f.sampleId, f.id)).toEqual(before);
    }
    h.rederiveHook.run = async () => {
      throw new AppError("INTERNAL");
    };
    try {
      await expect(
        h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, {
          feedbackKind: "compose",
          note: "故障时必须整体回滚",
          imageFileIds: [usable],
        }),
      ).rejects.toMatchObject({ error: "INTERNAL" });
    } finally {
      delete h.rederiveHook.run;
    }
    expect(await snapshot(f.sampleId, f.id)).toEqual(before);
  });

  it("老板/当前门店/真实暂停守卫不依赖旧GET响应", async () => {
    const f = await sample(),
      body = { feedbackKind: "compose" as const, note: "请调整声音" },
      other = await h.order(true);
    await h.delivery.merchantSample(f.o.viewer, f.item.id);
    const before = await snapshot(f.sampleId, f.id);
    await expect(
      h.delivery.sampleRequestChange(
        { ...f.o.viewer, membership: { ...f.o.viewer.membership, role: "clerk" } },
        f.sampleId,
        body,
      ),
    ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    await expect(
      h.delivery.sampleRequestChange(other.viewer, f.sampleId, body),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await snapshot(f.sampleId, f.id)).toEqual(before);
    const cause = await cancellationCause(h, f.o);
    await h.tx.run(async (tx) =>
      holdCancelReviewPauses(
        tx,
        h.deps,
        cause.ctx,
        await readCancelReviewHoldTargets(tx, h.assembly, cause.approvalId),
      ),
    );
    const paused = await snapshot(f.sampleId, f.id);
    await expect(
      h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, body),
    ).rejects.toMatchObject({ error: "TICKET_ON_HOLD" });
    await expect(h.delivery.sampleMarkSent(f.qc.ctx, f.qc.staff, f.sampleId)).rejects.toMatchObject(
      { error: "TICKET_ON_HOLD" },
    );
    expect(await snapshot(f.sampleId, f.id)).toEqual(paused);
  });

  it("markSent重验真实水印、范围与当前版本；重复登记不覆盖且不会产生商家查看/确认", async () => {
    const f = await sample(false),
      key = idem("admin.sample.markSent", f.qc.ctx.actor, f.sampleId, {}),
      watermark = await h.prisma.playableAsset.findFirstOrThrow({
        where: { sourceFileId: f.fileId, kind: "sample" },
      });
    await h.prisma.playableAsset.update({ where: { id: watermark.id }, data: { state: "failed" } });
    const unavailable = await snapshot(f.sampleId, f.id);
    await expect(h.delivery.sampleMarkSent(f.qc.ctx, f.qc.staff, f.sampleId)).rejects.toMatchObject(
      { error: "SAMPLE_PREVIEW_NOT_READY" },
    );
    expect(await snapshot(f.sampleId, f.id)).toEqual(unavailable);
    await h.prisma.playableAsset.update({
      where: { id: watermark.id },
      data: { state: watermark.state },
    });
    const outsider = await h.staff();
    await expect(
      h.delivery.sampleMarkSent(
        outsider.ctx,
        {
          ...outsider.staff,
          scope: ownTaskScope(outsider.staff.staff),
        },
        f.sampleId,
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    const before = await snapshot(f.sampleId, f.id);
    await h.delivery.sampleMarkSent(f.qc.ctx, f.qc.staff, f.sampleId, { idem: key() });
    const sent = await snapshot(f.sampleId, f.id);
    expect(sent.sample).toMatchObject({
      offlineSentAt: h.clock.now(),
      offlineSentByStaffId: f.qc.row.id,
      firstViewedAt: null,
      viewedAckAt: null,
      decidedAt: null,
      status: "qc_passed",
      previewChannels: [],
    });
    expect(sent.history).toBe(before.history);
    expect(sent.events).toBe(before.events);
    expect(sent.timers).toEqual(before.timers);
    h.clock.advance(60_000);
    const replayContext = key();
    await h.delivery.sampleMarkSent(f.qc.ctx, f.qc.staff, f.sampleId, { idem: replayContext });
    expect(replayContext.replayed).toBe(true);
    await h.delivery.sampleMarkSent(outsider.ctx, outsider.staff, f.sampleId);
    expect(await snapshot(f.sampleId, f.id)).toEqual(sent);
    await h.delivery.samplePush(f.qc.ctx, f.qc.staff, f.sampleId, {});
    await h.delivery.sampleMarkSent(f.qc.ctx, f.qc.staff, f.sampleId);
    const pushed = await h.prisma.sample.findUniqueOrThrow({ where: { id: f.sampleId } });
    expect(pushed).toMatchObject({
      offlineSentAt: sent.sample.offlineSentAt,
      decidedAt: null,
      firstViewedAt: null,
      viewedAckAt: null,
      previewChannels: ["weapp"],
      status: "pushed",
    });
    const readBefore = await snapshot(f.sampleId, f.id);
    await h.delivery.merchantSample(f.o.viewer, f.item.id);
    expect(await snapshot(f.sampleId, f.id)).toEqual(readBefore);
    await expect(
      h.delivery.sampleConfirm(f.o.viewer, f.sampleId, {
        versionNo: 1,
        viewedVia: "wecom",
        hasViewed: true,
      }),
    ).rejects.toMatchObject({ error: "SAMPLE_VIEW_CHANNEL_NOT_OFFERED" });
    await expect(
      h.delivery.sampleConfirm(f.o.viewer, f.sampleId, {
        versionNo: 1,
        viewedVia: "weapp",
        hasViewed: false,
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await snapshot(f.sampleId, f.id)).toEqual(readBefore);
    await h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, {
      feedbackKind: "compose",
      note: "重制后重发",
    });
    await expect(h.delivery.sampleMarkSent(f.qc.ctx, f.qc.staff, f.sampleId)).rejects.toMatchObject(
      { error: "STATE_NOT_ALLOWED" },
    );
  });

  it("既有R4只查询当前未暂停推送，真实提醒按接收人去重且不建立timer", async () => {
    const f = await sample(),
      pushed = await h.prisma.sample.findUniqueOrThrow({ where: { id: f.sampleId } }),
      reminders = remindersOf(h.assembly),
      target = { sampleId: f.sampleId, version: 1 },
      before = await snapshot(f.sampleId, f.id);
    const targets = await h.tx.run((tx) =>
      reminders.targets(tx, "R4", {
        pushedFrom: pushed.pushedAt!,
        pushedTo: pushed.pushedAt!,
      }),
    );
    expect(targets.filter((row) => row.sampleId === f.sampleId)).toEqual([target]);
    expect(await h.tx.run((tx) => reminders.revalidate(tx, "R4", target))).toEqual({ valid: true });
    expect(
      await h.tx.run((tx) => reminders.revalidate(tx, "R4", { ...target, version: 2 })),
    ).toEqual({ valid: false });
    expect(await snapshot(f.sampleId, f.id)).toEqual(before);
    notices.clock.set(atMinuteOfDay(addDays(calendarDate(pushed.pushedAt!), 2), 0));
    await notices.service.remindScan({ scheduledFor: notices.clock.now() });
    await notices.service.remindScan({ scheduledFor: notices.clock.now() });
    expect(
      await h.prisma.notification.count({
        where: { bizId: f.sampleId, sourceRule: "R4", node: "R1", merchantUserId: f.o.user.id },
      }),
    ).toBe(1);
    expect((await snapshot(f.sampleId, f.id)).timers).toEqual(before.timers);
    await h.delivery.sampleRequestChange(f.o.viewer, f.sampleId, {
      feedbackKind: "compose",
      note: "离开待确认后不再催办",
    });
    expect(await h.tx.run((tx) => reminders.revalidate(tx, "R4", target))).toEqual({
      valid: false,
    });
  });
});
