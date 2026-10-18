import { beforeAll, expect, it } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { createClock, useSeededDatabase } from "../testing/index.js";
import { harness, version } from "./__fixtures__/harness.js";
import { derivedHarness } from "./__fixtures__/derived-harness.js";

const db = useSeededDatabase("services");
let prisma: PrismaClient;
beforeAll(async () => {
  prisma = await db.prisma();
  // 共用协议在默认一月时钟下生效，四个独立十月时钟不受用例顺序影响。
  await version(harness(prisma));
}, 120000);

it.each([
  { name: "普通周日", from: "2026-10-18", min: "2026-10-27" },
  { name: "普通工作日", from: "2026-10-19", min: "2026-10-28" },
  { name: "国庆假日", from: "2026-10-03", min: "2026-10-15" },
  { name: "调休工作周六", from: "2026-10-10", min: "2026-10-20" },
])(
  "$name：报价、方案推送和确认共用订购后第7工作日，保留上下界",
  async ({ from, min }) => {
    const h = derivedHarness(
      harness(prisma, { clock: createClock(new Date(`${from}T04:00:00.000Z`)) }),
    );
    try {
      const o = await h.orderFixture();
      expect(calendarDate(o.o.submittedAt)).toBe(from);
      const quote = await h.order.quote(o.b.actor, {
        dramaIds: [o.d.id],
        isTopModel: false,
        channelAccountIds: [o.b.accountId],
      });
      expect(quote.earliestLaunchDate).toBe(min);
      const item = o.items[0]!,
        max = item.usageEndDate.toISOString().slice(0, 10);
      let draftLockVersion = 0;
      const save = async (date: string) => {
        await h.delivery.replaceDraft(o.staffCtx, o.staff, o.deliveryPlanId, {
          draftLockVersion,
          content: {
            focusCodes: ["W115F"],
            referenceAssetIds: [],
            note: null,
            launchMode: "merchant_self",
            items: [
              {
                orderItemId: item.id,
                channelAccountIds: [o.b.accountId],
                placements: [],
                agreedLaunchDate: date,
                expectedDeliveryDate: null,
              },
            ],
          },
        });
        draftLockVersion++;
      };
      for (const date of [addDays(min, -1), addDays(max, 1)]) {
        await save(date);
        await expect(
          h.delivery.push(o.staffCtx, o.staff, o.deliveryPlanId, { draftLockVersion }),
        ).rejects.toMatchObject({
          error: "LAUNCH_DATE_OUT_OF_RANGE",
          details: { orderItemId: item.id, minDate: min, maxDate: max },
        });
      }
      expect(
        await h.prisma.deliveryPlanVersion.count({ where: { deliveryPlanId: o.deliveryPlanId } }),
      ).toBe(0);
      await save(min);
      await h.delivery.push(o.staffCtx, o.staff, o.deliveryPlanId, { draftLockVersion });
      await h.delivery.confirm(o.b.actor, o.deliveryPlanId, { versionNo: 1 });
      expect(
        (await h.prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).agreedLaunchDate
          ?.toISOString()
          .slice(0, 10),
      ).toBe(min);
      expect(
        await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } }),
      ).toMatchObject({ status: "confirmed", confirmedVersionNo: 1 });
    } finally {
      h.clear();
    }
  },
  60000,
);
