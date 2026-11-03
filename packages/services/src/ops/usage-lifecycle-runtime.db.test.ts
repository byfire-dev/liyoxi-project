import { expect, it } from "vitest";
import { z } from "@liyoxi/contract";
import { createIdentityContext } from "../kernel/index.js";
import { createContentCopyright, createContentLicense, DramaPricePort } from "../content/index.js";
import { claimTimers, timerKey } from "../timers/index.js";
import {
  assembleForTest,
  createFactories,
  createFakeProviders,
  createLicenseConvergenceFixture,
  createTestWorkerServices,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import type { DeliveryRef } from "../events/index.js";

const db = useSeededDatabase("services", { max: 2 }),
  redis = useTestRedis();
it("使用期实例真实扇出/顺延，未交付到期不制造工单，关闭worker不借用API实例", async () => {
  const prisma = await db.prisma();
  const f = await createLicenseConvergenceFixture(prisma, {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  const api = f.runtime,
    queue: DeliveryRef[] = [];
  const worker = createTestWorkerServices({
    prisma,
    clock: f.clock,
    assembly: assembleForTest({ entry: "worker" }),
    providers: createFakeProviders({ clock: f.clock }),
    channel: {
      enqueue: async (_q, _id, payload) => {
        if ("eventId" in payload)
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
    const make = createFactories({ db: prisma, clock: f.clock }),
      staff = await make.staff({ staffRoleKey: "super_admin" });
    const ctx = createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } });
    const proof = await make.fileObject({
      category: "drama_license_doc",
      bucket: "secure",
      ext: "pdf",
      mime: "application/pdf",
    });
    await api.tx.run((tx) =>
      api.content.delist(tx, ctx, f.dramaId, {
        reasonCode: "ops_strategy",
        note: "隔离运行时真实版权顺延",
      }),
    );
    await api.tx.run((tx) =>
      createContentCopyright({
        clock: f.clock,
        media: api.media,
        events: api.events,
        prices: api.assembly.port(DramaPricePort),
        license: createContentLicense({ clock: f.clock, flow: api.flow, timers: api.timers }),
      }).revise(tx, ctx, f.dramaId, {
        lockVersion: 0,
        changeKind: "extend",
        reason: "真实事件扇出",
        confirm: { prevEndDate: "2035-12-31" },
        revisionProofFileIds: [proof.id],
        copyright: {
          source: "licensed",
          platforms: ["douyin", "wechat_channels"],
          territory: "中国大陆",
          hasNetworkRight: true,
          canSublicense: true,
          canEditEmbed: true,
          canAdapt: true,
          licenseStartDate: "2020-01-01",
          licenseEndDate: "2036-12-31",
          proofFileIds: [proof.id],
        },
      }),
    );
    await worker.relay();
    await worker.dispatch();
    const ref = queue.find((r) => r.subscriber === "publish.onLicenseExtended");
    expect(ref).toBeDefined();
    expect(await worker.consume(ref!)).toBe("done");
    expect(await worker.consume(ref!)).toBe("stale");
    const resync = await prisma.timer.findFirstOrThrow({
      where: { kind: "usage.resync", subjectId: f.order.itemId },
    });
    const claimed = (
      await api.tx.run((tx) => claimTimers(tx, api.timers.registry, f.clock.now()))
    ).claimed.find((r) => r.timerId === resync.id)!;
    expect(await worker.runTimer(claimed)).toBe("fired");
    expect(await worker.runTimer(claimed)).toBe("stale");
    expect(await prisma.orderItem.findUnique({ where: { id: f.order.itemId } })).toMatchObject({
      usageEndDate: new Date("2036-12-31"),
    });
    const subject = { type: "order_item", id: f.order.itemId };
    const armed = await api.tx.run((tx) =>
      api.timers.arm(tx, {
        kind: "usage.end",
        subject,
        key: timerKey("usage.end", subject, "2036-12-31"),
        fireAt: f.clock.now(),
      }),
    );
    const expiryRef = (
      await api.tx.run((tx) => claimTimers(tx, api.timers.registry, f.clock.now()))
    ).claimed.find((r) => r.timerId === armed.id)!;
    expect(await worker.runTimer(expiryRef)).toBe("skipped");
    expect(await prisma.deliveryTicket.count({ where: { orderItemId: f.order.itemId } })).toBe(0);
    const timer = await prisma.timer.findUniqueOrThrow({ where: { id: armed.id } });
    const input = {
      ...timer,
      payload: z.record(z.string(), z.unknown()).nullable().parse(timer.payload),
    };
    await worker.closeOrder?.();
    await expect(
      api.tx.run((tx) => worker.assembly.timerHandler("usage.end")!.handle(tx, input)),
    ).rejects.toThrow("已关闭");
    expect(
      await api.tx.run((tx) => api.assembly.timerHandler("usage.end")!.handle(tx, input)),
    ).toBe("skipped");
  } finally {
    await worker.closeOrder?.();
    worker.closeDelivery?.();
    await worker.closeDocs();
    await worker.closeNotify();
    await worker.closeStaff?.();
    worker.closeApproval?.();
    await worker.closeProfile?.();
    await f.close();
  }
}, 120_000);
