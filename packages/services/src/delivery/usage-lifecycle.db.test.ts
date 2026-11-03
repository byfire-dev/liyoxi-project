import {
  createUsageLifecycleRuntimeForTest,
  assembleForTest,
  createFakeProviders,
  createTestWorkerServices,
  fakeKeyEnv,
  useTestRedis,
} from "../testing/index.js";
import type { DeliveryRef } from "../events/index.js";
import { DISPATCH_BATCH_SIZE } from "../events/index.js";
import {
  bindUsageLifecycleOrderForTest,
  createUsageLifecycleForTest as createUsageLifecycle,
  openUsageCancellationForTest,
} from "../testing/index.js";
import { invalidateZipBundles, readCancelZipTargets } from "../media/index.js";
import { reviseUsage } from "./__fixtures__/usage-lifecycle.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "@liyoxi/contract";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { snapshotTables, useSeededDatabase } from "../testing/index.js";
import { loadEnv, uuidv7 } from "../kernel/index.js";
import { claimTimers, createTimers } from "../timers/index.js";
import { prepareReevaluation } from "./reevaluate-locks.js";
import { reevaluate } from "./reevaluate.js";
import { scheduleDeliveryUsage } from "./usage-lifecycle.js";
import { createDelivery } from "./index.js";
import { closeExpiredDeliveryPublish, readDeliveryPublishTargets } from "../publish/index.js";
import {
  cancellationCause,
  checks,
  m5Harness,
  m5Service,
  productionFile,
  released,
} from "./__fixtures__/m5.js";
import type { M5Harness } from "./__fixtures__/m5.js";

const db = useSeededDatabase("services", { max: 2 }),
  redis = useTestRedis();
let h: M5Harness, unbind: () => void;
beforeAll(async () => {
  h = m5Harness(await db.prisma());
  unbind = bindUsageLifecycleOrderForTest(h);
}, 120_000);
beforeEach(() => h.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(async () => {
  unbind?.();
  await h?.close();
});
const life = () => createUsageLifecycle(h.deps);
async function timer(kind: string, id: string) {
  const r = await h.prisma.timer.findFirstOrThrow({
    where: { kind, subjectId: id, status: { not: "cancelled" } },
    orderBy: { createdAt: "desc" },
  });
  return { ...r, payload: z.record(z.string(), z.unknown()).nullable().parse(r.payload) };
}
async function extend(f: Awaited<ReturnType<typeof released>>, end: string) {
  const { revision, event } = await reviseUsage(h, f, end);
  await h.tx.run((tx) =>
    life().onLicenseExtended(tx, {
      id: event.id,
      type: event.eventType,
      payload: z.record(z.string(), z.unknown()).parse(event.payload),
    }),
  );
  return { revision, fired: await timer("usage.resync", f.item.id) };
}

const tables = [
  "order_item",
  "delivery_ticket",
  "delivery_release",
  "download_grant",
  "takedown_task",
  "launch_task",
  "timer",
  "status_transition",
  "outbox_event",
] as const;

describe("W6-01 使用期真实交付事务", { timeout: 60_000 }, () => {
  it("API同形createDelivery未注入approval仍可在不足30天真实推包并确保下架；原到期入口缺审批拒绝", async () => {
    const { approval: _approval, ...apiDeps } = h.deps;
    expect("approval" in apiDeps).toBe(false);
    const f = await released({ ...h, delivery: createDelivery(apiDeps) }, false, async (target) => {
      h.clock.set(
        dayRange(addDays(target.item.usageEndDate.toISOString().slice(0, 10), -10)).start,
      );
    });
    expect(await h.prisma.takedownTask.findMany({ where: { orderItemId: f.item.id } })).toEqual([
      expect.objectContaining({ status: "pending_merchant", triggerKind: "expiry" }),
    ]);
    expect(
      await h.prisma.timer.count({
        where: { kind: "usage.end", subjectId: f.item.id, status: "scheduled" },
      }),
    ).toBe(1);
    h.clock.set(dayRange(addDays(f.item.usageEndDate.toISOString().slice(0, 10), 1)).start);
    await expect(
      h.tx.run(async (tx) => {
        await prepareReevaluation(tx, [f.id]);
        return closeExpiredDeliveryPublish(
          tx,
          apiDeps as unknown as Parameters<typeof closeExpiredDeliveryPublish>[1],
          f.qc.ctx,
          await readDeliveryPublishTargets(tx, [f.item.id]),
          { deliveryTicketId: f.id, now: h.clock.now() },
        );
      }),
    ).rejects.toMatchObject({ error: "INTERNAL" });
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "awaiting_launch",
    });
  });

  it("真实推包登记两定时器；顺延并发只有一次效果，旧代到期跳过且不恢复下载授权", async () => {
    const f = await released(h),
      oldEnd = f.item.usageEndDate.toISOString().slice(0, 10),
      oldTimer = await timer("usage.end", f.item.id);
    expect(oldTimer.fireAt).toEqual(dayRange(addDays(oldEnd, 1)).start);
    expect((await timer("takedown.create", f.item.id)).fireAt).toEqual(
      dayRange(addDays(oldEnd, -30)).start,
    );
    expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
      phase: "to_launch",
    });
    const next = addDays(oldEnd, 90),
      { fired } = await extend(f, next);
    expect(
      await Promise.all([
        h.tx.run((tx) => life().handle(tx, fired)),
        h.tx.run((tx) => life().handle(tx, fired)),
      ]),
    ).toEqual(expect.arrayContaining(["fired", "skipped"]));
    const timers = await h.prisma.timer.findMany({
      where: {
        subjectId: f.item.id,
        kind: { in: ["usage.end", "takedown.create"] },
        status: { in: ["scheduled", "dispatched"] },
      },
    });
    expect(timers).toHaveLength(2);
    expect(timers.every((r) => r.dedupeKey.endsWith(next))).toBe(true);
    h.clock.set(dayRange(addDays(oldEnd, 1)).start);
    expect(await h.tx.run((tx) => life().handle(tx, oldTimer))).toBe("skipped");
    const count = await h.prisma.downloadGrant.count({ where: { orderItemId: f.item.id } });
    const before = await snapshotTables(h.prisma, tables);
    expect(await h.tx.run((tx) => life().handle(tx, fired))).toBe("skipped");
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    expect(await h.prisma.downloadGrant.count({ where: { orderItemId: f.item.id } })).toBe(count);
  });

  it("已登记顺延遇在途取消保留重试条件，不能永久skipped丢掉同revision补偿", async () => {
    const f = await released(h),
      { fired } = await extend(f, addDays(f.item.usageEndDate.toISOString().slice(0, 10), 30));
    const cause = await cancellationCause(h, f.o);
    await h.tx.run((tx) => openUsageCancellationForTest(tx, h.deps, f.o.order.id, cause.id));
    const before = await snapshotTables(h.prisma, tables);
    await expect(h.tx.run((tx) => life().handle(tx, fired))).rejects.toMatchObject({
      error: "PRECONDITION_CHANGED",
    });
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    expect(await h.prisma.timer.findUnique({ where: { id: fired.id } })).toMatchObject({
      status: "scheduled",
    });
  });

  it("上海零点到期唯一收尾；事件写入失败整笔回滚，重放不增历史", async () => {
    const f = await released(h),
      fired = await timer("usage.end", f.item.id);
    h.clock.set(new Date(fired.fireAt.getTime() - 1));
    expect(await h.tx.run((tx) => life().handle(tx, fired))).toBe("skipped");
    h.clock.advance(1);
    const before = await snapshotTables(h.prisma, tables);
    const broken = createUsageLifecycle({
      ...h.deps,
      flow: {
        ...h.flow,
        transition: async (...args) => {
          const result = await h.flow.transition(...args);
          if (args[2].event === "usage.ended") throw new Error("lyxtest.expiry.rollback");
          return result;
        },
      },
    });
    await expect(h.tx.run((tx) => broken.handle(tx, fired))).rejects.toThrow(
      "lyxtest.expiry.rollback",
    );
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    expect(await h.tx.run((tx) => life().handle(tx, fired))).toBe("fired");
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "takedown",
    });
    expect(await h.prisma.launchTask.findMany({ where: { orderItemId: f.item.id } })).toEqual([
      expect.objectContaining({ reviewStatus: "void", voidReason: "usage_expired" }),
    ]);
    expect(
      await h.prisma.takedownTask.count({
        where: { orderItemId: f.item.id, status: { not: "void" } },
      }),
    ).toBe(1);
    expect(await h.prisma.downloadGrant.findMany({ where: { orderItemId: f.item.id } })).toEqual([
      expect.objectContaining({ state: "revoked" }),
    ]);
    // Original 10:883: the package closes at archival, not at unlaunched expiry.
    expect(
      await h.prisma.deliveryRelease.findUnique({ where: { id: f.release.deliveryReleaseId } }),
    ).toMatchObject({ state: "pushed" });
    const after = await snapshotTables(h.prisma, tables);
    expect(await h.tx.run((tx) => life().handle(tx, fired))).toBe("skipped");
    expect(await snapshotTables(h.prisma, tables)).toEqual(after);
    // Expired stages are excluded by fan-out; old usage.resync deliveries are separately guarded.
    expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
      usageEndDate: f.item.usageEndDate,
    });
  });
  it("T-30按真实公开writer生成；续期作废尚未到期pending且事务失败保留原全部事实", async () => {
    const f = await released(h),
      end = f.item.usageEndDate.toISOString().slice(0, 10);
    h.clock.set(dayRange(addDays(end, -30)).start);
    await h.tx.run(async (tx) => {
      await prepareReevaluation(tx, [f.id]);
      await scheduleDeliveryUsage(tx, h.deps, f.qc.ctx, f.id);
    });
    const task = await h.prisma.takedownTask.findFirstOrThrow({
      where: { orderItemId: f.item.id },
    });
    expect(task).toMatchObject({
      status: "pending_merchant",
      triggerKind: "expiry",
      dueDate: f.item.usageEndDate,
    });
    const { fired } = await extend(f, addDays(end, 90));
    const before = await snapshotTables(h.prisma, tables);
    const broken = createUsageLifecycle({
      ...h.deps,
      events: {
        emit: async (...args) => {
          if (args[2].type === "order.item.usage_end_changed")
            throw new Error("lyxtest.extension.rollback");
          return h.events.emit(...args);
        },
      },
    });
    await expect(h.tx.run((tx) => broken.handle(tx, fired))).rejects.toThrow(
      "lyxtest.extension.rollback",
    );
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    expect(await h.tx.run((tx) => life().handle(tx, fired))).toBe("fired");
    expect(await h.prisma.takedownTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: "void",
    });
    expect(
      await h.prisma.timer.count({
        where: { subjectId: task.id, status: { in: ["scheduled", "dispatched"] } },
      }),
    ).toBe(0);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: task.id, event: "takedown.void" },
      }),
    ).toBe(1);
  });

  it.each(["available", "missing", "cancelled"] as const)(
    "历史到期关闭包边界%s：只恢复最后有效版本的引用，不新授grant、不回写下载证据",
    async (scenario) => {
      const f = await released(h),
        service = m5Service(h);
      await h.prisma.dictItem.upsert({
        where: { dictTypeKey_code: { dictTypeKey: "reissue_reason", code: "content_fix" } },
        create: {
          id: uuidv7(),
          dictTypeKey: "reissue_reason",
          code: "content_fix",
          name: "内容修正",
          isEnabled: true,
          position: 1,
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
        update: {},
      });
      const request = await service.reissueCreate(f.qc.ctx, f.qc.staff, f.id, {
        episodeNos: [1],
        reasonCode: "content_fix",
        note: "真实第二版包用于历史消费边界",
      });
      const fileId = await productionFile(h, f.o, f.editor, "final_episode");
      const output = await h.delivery.episodeRegister(f.editor.ctx, f.editor.staff, f.id, {
        reissueId: request.reissueId,
        items: [{ episodeNo: 1, fileId }],
      });
      const qc = await checks(h, "qc.episode");
      await h.delivery.episodeInspect(f.qc.ctx, f.qc.staff, f.id, {
        episodeOutputIds: [output.items[0]!.episodeOutputId],
        checklistVersionNo: qc.checklistVersionNo,
        defaultResults: qc.results,
      });
      const second = await service.reissuePublish(f.qc.ctx, f.qc.staff, request.reissueId, {
        precheck: await checks(h, "delivery.precheck"),
      });
      const lastId = second.release.deliveryReleaseId,
        end = f.item.usageEndDate.toISOString().slice(0, 10);
      h.clock.set(dayRange(addDays(end, 1)).start);
      // Explicit legacy input: current producer closes only after archive and cannot naturally reach this shape.
      // The original double guard remains: no archived revival, no cancelled-package revival.
      await h.tx.run(async (tx) => {
        await prepareReevaluation(tx, [f.id]);
        const ids = [f.release.deliveryReleaseId, lastId];
        await tx.deliveryRelease.updateMany({
          where: { id: { in: ids } },
          data: {
            state: "closed",
            supersededAt: null,
            closeReason: scenario === "cancelled" ? "cancelled" : "usage_ended",
            closedAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
        await tx.downloadGrant.updateMany({
          where: { orderItemId: f.item.id, state: "active" },
          data: { state: "revoked", endedAt: h.clock.now(), updatedAt: h.clock.now() },
        });
        await invalidateZipBundles(tx, await readCancelZipTargets(tx, ids), h.clock.now());
      });
      if (scenario === "missing")
        await h.prisma.fileObject.update({
          where: { id: fileId },
          data: { status: "deleted", deletedAt: h.clock.now() },
        });
      const grants = await snapshotTables(h.prisma, ["download_grant", "delivery_download_log"]);
      const { fired } = await extend(f, addDays(end, 90));
      expect(await h.tx.run((tx) => life().handle(tx, fired))).toBe("fired");
      expect(
        await h.prisma.deliveryRelease.findUnique({ where: { id: f.release.deliveryReleaseId } }),
      ).toMatchObject({ state: "closed" });
      expect(await h.prisma.deliveryRelease.findUnique({ where: { id: lastId } })).toMatchObject({
        state: scenario === "available" ? "pushed" : "closed",
      });
      expect(await snapshotTables(h.prisma, ["download_grant", "delivery_download_log"])).toEqual(
        grants,
      );
      expect(
        await h.prisma.fileRef.findMany({ where: { refType: "delivery_release", refId: lastId } }),
      ).toEqual([
        expect.objectContaining({ state: scenario === "available" ? "live" : "released" }),
      ]);
    },
  );

  it.each(["expired", "early", "early-longer"] as const)(
    "%s归档消费者接受历史核查输入，实际时间/使用止日留存与order端口同事务（不验W6-04核查）",
    async (scenario) => {
      const f = await released(h),
        fired = await timer("usage.end", f.item.id),
        end = f.item.usageEndDate.toISOString().slice(0, 10),
        requiredKeepUntil = dayRange(addDays(end, 91)).start,
        longerKeepUntil = dayRange(addDays(end, 120)).start;
      if (scenario === "expired") {
        h.clock.set(fired.fireAt);
        expect(await h.tx.run((tx) => life().handle(tx, fired))).toBe("fired");
      } else {
        // Real launch producer reaches in_service before the original end; only later checked input is historical.
        const launch = await h.prisma.launchTask.findFirstOrThrow({
          where: { deliveryTicketId: f.id },
        });
        await h.deps.publish.submitLaunch(f.o.viewer, launch.id, {
          linkKind: "collection",
          collectionUrl: `https://example.invalid/w601/${launch.id}`,
          reportedEpisodeCount: 1,
          actualLaunchDate: calendarDate(h.clock.now()),
        });
        const submission = await h.prisma.launchSubmission.findFirstOrThrow({
          where: { launchTaskId: launch.id },
          include: { approvalRequest: true },
        });
        await h.deps.publish.approveLaunch(f.qc.ctx, f.qc.staff, submission.id, {
          lockVersion: submission.approvalRequest.lockVersion,
          confirm: {
            roundNo: submission.roundNo,
            reportedEpisodeCount: submission.reportedEpisodeCount,
          },
          verifiedEpisodeCount: 1,
          ...(await checks(h, "launch.verify")),
        });
        expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
          step: "in_service",
        });
        h.clock.set(dayRange(addDays(end, -20)).start);
        await h.tx.run(async (tx) => {
          await prepareReevaluation(tx, [f.id]);
          await scheduleDeliveryUsage(tx, h.deps, f.qc.ctx, f.id);
        });
        expect(calendarDate(h.clock.now()) < end).toBe(true);
      }
      const archivedAt = h.clock.now();
      const task = await h.prisma.takedownTask.findFirstOrThrow({
        where: { orderItemId: f.item.id },
      });
      // Controlled historical input only: W6-04's merchant/check handler is not implemented here.
      // Preserve the two historical links and every required sampled-out fact instead of claiming a check ran.
      await h.tx.run(async (tx) => {
        await prepareReevaluation(tx, [f.id]);
        await tx.takedownTask.update({
          where: { id: task.id },
          data: {
            status: "checked",
            merchantMethod: scenario === "expired" ? "not_published" : "delete",
            merchantConfirmedAt: h.clock.now(),
            merchantConfirmedByUserId: f.o.user.id,
            checkedAt: h.clock.now(),
            checkMethod: "sampled_out",
          },
        });
        for (const [fromState, toState, event, actorType, actorId, client] of [
          [
            "pending_merchant",
            "merchant_confirmed",
            "takedown.confirm",
            "merchant",
            f.o.user.id,
            "weapp",
          ],
          ["merchant_confirmed", "checked", "takedown.sample_release", "system", null, null],
        ] as const)
          await tx.statusTransition.create({
            data: {
              id: uuidv7(),
              machine: "takedown_task",
              stateField: "status",
              subjectId: task.id,
              entityId: task.entityId,
              storeId: task.storeId,
              fromState,
              toState,
              event,
              actorType,
              actorId,
              client,
              occurredAt: h.clock.now(),
              bizDate: new Date(calendarDate(h.clock.now())),
              payload: { fixture: "historical_takedown_check", notW604Acceptance: true },
            },
          });
        await createTimers({ assembly: h.assembly }).cancel(tx, {
          subject: { type: "takedown_task", id: task.id },
          kinds: ["takedown.overdue"],
        });
        if (scenario === "early-longer") {
          // Historical explicit retention is a media input; archival must never shorten it.
          const refs = await tx.fileRef.findMany({
            where: { refType: "delivery_release", refId: f.release.deliveryReleaseId, role: "ep" },
          });
          for (const ref of refs)
            await h.media.release(tx, {
              fileId: ref.fileId,
              refType: ref.refType,
              refId: ref.refId,
              role: ref.role,
              entityId: f.o.entity.id,
              storeId: f.o.store.id,
              keepUntil: longerKeepUntil,
            });
        }
      });
      const zip = await h.prisma.zipBundle.create({
        data: {
          id: uuidv7(),
          ownerType: "delivery_release",
          ownerId: f.release.deliveryReleaseId,
          zipState: "building",
          zipGen: 1,
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      const before = await snapshotTables(h.prisma, [
        ...tables,
        "zip_bundle",
        "file_ref",
        "file_object",
      ]);
      if (scenario === "expired") {
        const { media: _media, ...withoutMedia } = h.deps;
        await expect(
          h.tx.run((tx) => reevaluate(tx, withoutMedia, f.qc.ctx, f.id)),
        ).rejects.toMatchObject({ error: "INTERNAL" });
        expect(
          await snapshotTables(h.prisma, [...tables, "zip_bundle", "file_ref", "file_object"]),
        ).toEqual(before);
      }
      await expect(
        h.tx.run(async (tx) => {
          await reevaluate(tx, h.deps, f.qc.ctx, f.id);
          throw new Error("lyxtest.archive.rollback");
        }),
      ).rejects.toThrow("lyxtest.archive.rollback");
      expect(
        await snapshotTables(h.prisma, [...tables, "zip_bundle", "file_ref", "file_object"]),
      ).toEqual(before);
      expect(await h.tx.run((tx) => reevaluate(tx, h.deps, f.qc.ctx, f.id))).toEqual({
        moved: scenario === "expired" ? 1 : 2,
      });
      expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
        phase: "ended",
      });
      expect(await h.prisma.dramaOrder.findUnique({ where: { id: f.o.order.id } })).toMatchObject({
        status: "ended",
      });
      expect(
        await h.prisma.deliveryRelease.findUnique({ where: { id: f.release.deliveryReleaseId } }),
      ).toMatchObject({ state: "closed", closeReason: "usage_ended", closedAt: archivedAt });
      expect(await h.prisma.zipBundle.findUnique({ where: { id: zip.id } })).toMatchObject({
        zipState: "none",
        zipGen: 2,
        updatedAt: archivedAt,
      });
      const retained = await h.prisma.fileRef.findMany({
        where: { refType: "delivery_release", refId: f.release.deliveryReleaseId, role: "ep" },
      });
      const expectedKeepUntil = scenario === "early-longer" ? longerKeepUntil : requiredKeepUntil;
      expect(retained.length).toBeGreaterThan(0);
      for (const ref of retained) {
        expect(ref).toMatchObject({
          state: "released",
          releasedAt: archivedAt,
          keepUntil: expectedKeepUntil,
        });
        // Other real source references still keep the file live, so purgeAfter must remain null.
        expect(await h.prisma.fileObject.findUnique({ where: { id: ref.fileId } })).toMatchObject({
          purgeAfter: null,
        });
      }
      // Independently exercise the public media cache recalculation after the other references release.
      // Roll this probe back: it is not an assertion that their own lifecycle cleanup has run.
      await expect(
        h.tx.run(async (tx) => {
          await prepareReevaluation(tx, [f.id]);
          for (const retainedRef of retained) {
            const otherRefs = await tx.fileRef.findMany({
              where: { fileId: retainedRef.fileId, state: "live" },
            });
            for (const ref of otherRefs)
              await h.media.release(tx, {
                fileId: ref.fileId,
                refType: ref.refType,
                refId: ref.refId,
                role: ref.role,
                entityId: f.o.entity.id,
                storeId: f.o.store.id,
                keepUntil: archivedAt,
              });
            expect(
              await tx.fileObject.findUnique({ where: { id: retainedRef.fileId } }),
            ).toMatchObject({ purgeAfter: expectedKeepUntil });
          }
          throw new Error("lyxtest.retention.probe.rollback");
        }),
      ).rejects.toThrow("lyxtest.retention.probe.rollback");
      expect(
        await h.prisma.outboxEvent.count({
          where: { eventType: "ticket.archived", aggregateId: f.id },
        }),
      ).toBe(1);
      const after = await snapshotTables(h.prisma, tables);
      expect(await h.tx.run((tx) => reevaluate(tx, h.deps, f.qc.ctx, f.id))).toEqual({ moved: 0 });
      expect(await snapshotTables(h.prisma, tables)).toEqual(after);
      const { event } = await reviseUsage(
        h,
        f,
        addDays(f.item.usageEndDate.toISOString().slice(0, 10), 90),
      );
      await h.tx.run((tx) =>
        life().onLicenseExtended(tx, {
          id: event.id,
          type: event.eventType,
          payload: z.record(z.string(), z.unknown()).parse(event.payload),
        }),
      );
      expect(
        await h.prisma.timer.count({ where: { kind: "usage.resync", subjectId: f.item.id } }),
      ).toBe(0);
      expect(
        await h.prisma.deliveryRelease.findUnique({ where: { id: f.release.deliveryReleaseId } }),
      ).toMatchObject({ state: "closed", closeReason: "usage_ended" });
    },
  );
});

it("W6-01 API与真实worker relay→dispatch→consume→runTimer，重放零重复且关闭不回退另一实例", async () => {
  const f = await released(h),
    end = f.item.usageEndDate.toISOString().slice(0, 10);
  const api = createUsageLifecycleRuntimeForTest({
    entry: "api",
    version: "test",
    clock: h.clock,
    env: { ...loadEnv(), ...fakeKeyEnv(), DATABASE_URL: await db.url() },
    providers: createFakeProviders({ clock: h.clock }),
    redisKeyPrefix: redis.prefix,
  });
  const queue: DeliveryRef[] = [];
  const worker = createTestWorkerServices({
    prisma: h.prisma,
    clock: h.clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock: h.clock }),
    channel: {
      enqueue: async (_queue, _id, payload) => {
        if (typeof payload === "object" && payload !== null && "eventId" in payload)
          queue.push(
            z
              .object({ eventId: z.string(), subscriber: z.string(), dispatchNo: z.number() })
              .parse(payload),
          );
      },
      downForMs: () => 0,
    },
  });
  try {
    const { event } = await reviseUsage(h, f, addDays(end, 90));
    await worker.relay();
    // The shared fixture also has earlier real deliveries. Drain finite batches at the original limit.
    const pendingDeliveries = await h.prisma.outboxDelivery.count({ where: { status: "pending" } });
    for (let batch = 0; batch < Math.ceil(pendingDeliveries / DISPATCH_BATCH_SIZE); batch++)
      expect((await worker.dispatch()).claimed).toBeGreaterThan(0);
    const delivery = queue.find(
      (r) => r.eventId === event.id && r.subscriber === "publish.onLicenseExtended",
    );
    expect(delivery).toBeDefined();
    expect(await worker.consume(delivery!)).toBe("done");
    expect(await worker.consume(delivery!)).toBe("stale");
    const pending = await h.prisma.timer.findFirstOrThrow({
      where: { kind: "usage.resync", subjectId: f.item.id },
    });
    const claim = await api.tx.run((tx) => claimTimers(tx, api.timers.registry, h.clock.now()));
    const ref = claim.claimed.find((r) => r.timerId === pending.id);
    expect(ref).toBeDefined();
    expect(await worker.runTimer(ref!)).toBe("fired");
    expect(await worker.runTimer(ref!)).toBe("stale");
    expect(await h.prisma.orderItem.findUnique({ where: { id: f.item.id } })).toMatchObject({
      usageEndDate: new Date(addDays(end, 90)),
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "order.item.usage_end_changed", aggregateId: f.item.id },
      }),
    ).toBe(1);
    const expiry = await h.prisma.timer.findFirstOrThrow({
      where: { kind: "usage.end", subjectId: f.item.id, status: "scheduled" },
    });
    h.clock.set(dayRange(addDays(end, 91)).start);
    // Scanner leases use PostgreSQL real now. Set the technical lease only; business time remains injected.
    await h.prisma.timer.update({
      where: { id: expiry.id },
      data: {
        status: "dispatched",
        dispatchNo: 1,
        leaseUntil: new Date(h.clock.now().getTime() + 300000),
      },
    });
    const expiryRef = { timerId: expiry.id, kind: "usage.end", dispatchNo: 1 };
    expect(await worker.runTimer(expiryRef)).toBe("fired");
    expect(await worker.runTimer(expiryRef)).toBe("stale");
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: f.id } })).toMatchObject({
      step: "takedown",
    });
    const saved = worker.assembly.timerHandler("usage.end")!;
    const input = {
      ...expiry,
      payload: z.record(z.string(), z.unknown()).nullable().parse(expiry.payload),
    };
    await worker.closeOrder?.();
    await expect(api.tx.run((tx) => saved.handle(tx, input))).rejects.toThrow("已关闭");
    expect(
      await api.tx.run((tx) => api.assembly.timerHandler("usage.end")!.handle(tx, input)),
    ).toBe("skipped");
    await expect(
      api.tx.run((tx) =>
        worker.assembly.subscriber("publish.onLicenseExtended")!.handle(tx, {
          id: event.id,
          type: event.eventType,
          payload: z.record(z.string(), z.unknown()).parse(event.payload),
        }),
      ),
    ).rejects.toThrow("已关闭");
  } finally {
    await worker.closeOrder?.();
    worker.closeDelivery?.();
    await worker.closeDocs();
    await worker.closeNotify();
    await worker.closeStaff?.();
    worker.closeApproval?.();
    await worker.closeProfile?.();
    await api.close();
  }
}, 120_000);
