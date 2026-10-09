import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, expect, it } from "vitest";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createTenant } from "../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createTestStaffAuth,
  useSeededDatabase,
} from "../testing/index.js";
import { bootstrap } from "./bootstrap.js";
import type { IdentityReadDeps } from "./read.types.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T04:00:00Z"));
let prisma: PrismaClient, deps: IdentityReadDeps;
let h: ReturnType<typeof createTestStaffAuth>, make: ReturnType<typeof createFactories>;
let assembly: ReturnType<typeof assembleForTest>;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createTestStaffAuth(prisma, { clock });
  assembly = assembleForTest({ entry: "api" });
  const events = createEvents({ assembly, clock, tx: h.tx });
  const flow = createFlow({ assembly, clock, events });
  make = createFactories({ db: prisma, clock });
  deps = {
    tx: h.tx,
    clock,
    assembly,
    docs: createDocs({ tx: h.tx, clock }),
    tenant: createTenant({ tx: h.tx, clock, assembly, flow }),
    config: createConfig({ db: prisma, clock, redis: null }),
  };
  for (const [slotKey, providerTemplateId] of Object.entries({
    review_result: "fixture-review",
    pay_result: "fixture-pay",
    svc_expiry: "fixture-expiry",
    quota_change: "fixture-quota",
  }))
    await prisma.wxTemplateSlot.update({
      where: { slotKey },
      data: { providerTemplateId, status: "active", fields: [], updatedAt: clock.now() },
    });
}, 120_000);
it("匿名不读取个人槽位，登录实际配置/参数7/3且未配置项不伪造", async () => {
  const anonymous = await bootstrap(deps, { merchantUserId: null, storeId: null });
  expect(anonymous.subscribePlan).toBeNull();
  expect([anonymous.subscribeCooldownDays, anonymous.subscribeMaxPerAsk]).toEqual([7, 3]);
  const merchant = await make.merchant();
  const result = await bootstrap(deps, {
    merchantUserId: merchant.user.id,
    storeId: merchant.store.id,
    platform: "android",
    clientVersion: "2.0.0",
  });
  expect(result.degraded).not.toContain("subscribe");
  expect(result.subscribePlan?.find((point) => point.point === "profile_submit")?.slots).toEqual([
    { slotKey: "review_result", tmplId: "fixture-review" },
  ]);
  expect(
    result.subscribePlan
      ?.find((point) => point.point === "pay_success")
      ?.slots.map((slot) => slot.slotKey),
  ).toEqual(["pay_result", "svc_expiry", "quota_change"]);
  expect(result.subscribePlan?.some((point) => point.point === "ticket_reply")).toBe(false);
});
