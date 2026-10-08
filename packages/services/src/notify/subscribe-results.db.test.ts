import type { PrismaClient } from "@liyoxi/db";
import type { SubscribeResultBody } from "@liyoxi/contract";
import { beforeAll, describe, expect, it } from "vitest";
import { createConfig } from "../config/index.js";
import {
  assertNotInTransaction,
  createIdempotencyContext,
  createTxRunner,
  subscribePlanOf,
  uuidv7,
} from "../kernel/index.js";
import type { AlertInput, TxRunner } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  useSeededDatabase,
} from "../testing/index.js";
import type { Factories } from "../testing/index.js";
import { createSubscribeResults, readSubscribePlan } from "./subscribe-results.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T04:00:00Z"));
let prisma: PrismaClient, tx: TxRunner, make: Factories;
const alerts: AlertInput[] = [];
const logs: Readonly<Record<string, unknown>>[] = [];
let service: ReturnType<typeof createSubscribeResults>;
const templates = {
  review_result: "fixture-review",
  ticket_reply: "fixture-ticket",
  pay_result: "fixture-pay",
  svc_expiry: "fixture-expiry",
  quota_change: "fixture-quota",
};
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  make = createFactories({ db: prisma, clock });
  for (const [slotKey, providerTemplateId] of Object.entries(templates))
    await prisma.wxTemplateSlot.update({
      where: { slotKey },
      data: { providerTemplateId, status: "active", fields: [], updatedAt: clock.now() },
    });
  await prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: "notify.wx.quota_cap",
      value: 2,
      effectiveAt: clock.now(),
      createdAt: clock.now(),
      createdByStaffId: uuidv7(),
    },
  });
  const config = createConfig({ db: prisma, clock, redis: null });
  service = createSubscribeResults({
    tx,
    clock,
    params: config.params,
    alerts: {
      raise: async (input) => {
        assertNotInTransaction("alerts.raise");
        alerts.push(input);
      },
    },
    logger: { info: (row) => logs.push(row) },
  });
}, 120_000);
async function principal() {
  const user = await make.merchantUser();
  const identity = await prisma.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId: user.id,
      appid: "wxfixture00000001",
      openid: `fixture-${uuidv7()}`,
      lastLoginAt: clock.now(),
      lastActiveAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
  return { merchantUserId: user.id, wechatIdentityId: identity.id };
}
function context(
  body: SubscribeResultBody,
  userId: string,
  key = `subscribeReport:${body.reportId}`,
) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.subscribeResult.create",
    key,
    actor: { type: "merchant", id: userId, client: "weapp", role: null },
    request: { method: "POST", pathParams: {}, body, storeId: null },
  });
}
function body(
  result: "accept" | "reject" | "ban" | "filter",
  tmplId = templates.review_result,
): SubscribeResultBody {
  return { reportId: uuidv7(), point: "profile_submit", results: [{ tmplId, result }] };
}
async function apply(p: Awaited<ReturnType<typeof principal>>, input: SubscribeResultBody) {
  return service.apply(p, input, { idem: context(input, p.merchantUserId) });
}
const quota = (p: Awaited<ReturnType<typeof principal>>) =>
  prisma.wxSubscribeQuota.findUnique({
    where: {
      wechatIdentityId_wxTemplateSlotKey: {
        wechatIdentityId: p.wechatIdentityId,
        wxTemplateSlotKey: "review_result",
      },
    },
  });
describe("真实订阅结果与身份额度", () => {
  it("accept/replay/并发只增一次并封顶，两个微信身份分开计数", async () => {
    const p = await principal(),
      input = body("accept");
    const results = await Promise.all(Array.from({ length: 8 }, () => apply(p, input)));
    expect(results.every((row) => row.appliedCount === 1)).toBe(true);
    expect((await quota(p))?.estRemaining).toBe(1);
    await Promise.all(Array.from({ length: 5 }, () => apply(p, body("accept"))));
    expect((await quota(p))?.estRemaining).toBe(2);
    const other = await principal();
    await apply(other, body("accept"));
    expect((await quota(other))?.estRemaining).toBe(1);
  });
  it("reject/filter不改额度，ban清零且重复不重复告警，accept可恢复", async () => {
    const p = await principal();
    await apply(p, body("accept"));
    const acceptedAt = (await quota(p))?.lastAcceptAt;
    expect(await apply(p, body("reject"))).toEqual({ appliedCount: 0, ignoredCount: 1 });
    const filter = body("filter"),
      count = alerts.length;
    await apply(p, filter);
    await apply(p, filter);
    expect(alerts.slice(count)).toEqual([
      {
        rule: "notify.wx_filtered",
        dimension: "review_result",
        severity: "P3",
        detail: { point: "profile_submit", slotKey: "review_result", result: "filter" },
      },
    ]);
    expect((await quota(p))?.estRemaining).toBe(1);
    const ban = body("ban");
    await apply(p, ban);
    await apply(p, ban);
    expect(await quota(p)).toMatchObject({
      state: "banned",
      estRemaining: 0,
      lastAcceptAt: acceptedAt,
    });
    await apply(p, body("accept"));
    expect(await quota(p)).toMatchObject({ state: "ok", estRemaining: 1 });
  });
  it("未知模板不写额度/告警，开关关闭仍受理且日志不含原模板/凭据", async () => {
    const p = await principal(),
      count = alerts.length;
    const unknown = body("ban", "unknown-provider-template");
    expect(await apply(p, unknown)).toEqual({ appliedCount: 0, ignoredCount: 1 });
    expect(alerts.length).toBe(count);
    expect(await quota(p)).toBeNull();
    await prisma.featureFlag.update({
      where: { key: "notify.wx.enabled" },
      data: { defaultValue: false, updatedAt: clock.now() },
    });
    await apply(p, body("accept"));
    expect((await quota(p))?.estRemaining).toBe(1);
    expect(JSON.stringify(logs)).not.toContain("fixture-review");
    expect(JSON.stringify(logs)).not.toContain(p.wechatIdentityId);
  });
  it("不接受别人的identity、错误幂等键或客户端额外身份", async () => {
    const a = await principal(),
      b = await principal(),
      input = body("accept");
    await expect(
      service.apply({ ...a, wechatIdentityId: b.wechatIdentityId }, input, {
        idem: context(input, a.merchantUserId),
      }),
    ).rejects.toMatchObject({ error: "AUTH_REQUIRED" });
    await expect(
      service.apply(a, input, { idem: context(input, a.merchantUserId, "subscribeReport:wrong") }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    await expect(
      service.apply(a, { ...input, merchantUserId: b.merchantUserId } as SubscribeResultBody, {
        idem: context(input, a.merchantUserId),
      }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await quota(a)).toBeNull();
    expect(await quota(b)).toBeNull();
  });
  it("固定真实槽位，按模式隐藏支付/续费与hidden服务额度；bootstrap端口采用正式finance策略", async () => {
    const inApp = await tx.run((t) => readSubscribePlan(t, { purchaseMode: "in_app" }));
    expect(inApp.find((point) => point.point === "profile_submit")?.slots).toEqual([
      { slotKey: "review_result", tmplId: "fixture-review" },
    ]);
    expect(
      inApp.find((point) => point.point === "pay_success")?.slots.map((slot) => slot.slotKey),
    ).toEqual(["pay_result", "svc_expiry", "quota_change"]);
    const hidden = await tx.run((t) => readSubscribePlan(t, { purchaseMode: "hidden" }));
    expect(
      hidden.some((point) => point.point === "pay_success" || point.point === "renew_enter"),
    ).toBe(false);
    expect(
      hidden
        .flatMap((point) => point.slots)
        .some((slot) => ["svc_expiry", "quota_change"].includes(slot.slotKey)),
    ).toBe(false);
    await prisma.wxTemplateSlot.update({
      where: { slotKey: "ticket_reply" },
      data: { status: "unconfigured", providerTemplateId: null, updatedAt: clock.now() },
    });
    expect(
      (await tx.run((t) => readSubscribePlan(t, { purchaseMode: "in_app" }))).some(
        (point) => point.point === "ticket_reply",
      ),
    ).toBe(false);
    const read = subscribePlanOf(assembleForTest({ entry: "api" }));
    expect(
      await tx.run((t) =>
        read(t, { platform: "ios", clientVersion: "1.0.0", entityId: null, now: clock.now() }),
      ),
    ).toEqual(await tx.run((t) => readSubscribePlan(t, { purchaseMode: "in_app" })));
  });
});
