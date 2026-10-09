import { beforeAll, expect, it } from "vitest";
import { createConfig } from "../config/index.js";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  createClock,
  createFactories,
  useSeededDatabase,
  createNotifySessionFixture,
  createNotifyQuotaFixture,
} from "../testing/index.js";
import { createNotifyMessages } from "./messages.js";

const db = useSeededDatabase("services");
const clock = createClock();
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let make: ReturnType<typeof createFactories>;
let tx: ReturnType<typeof createTxRunner>;
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120_000);
const build = (mode: "in_app" | "offline_contract" | "hidden" = "in_app") =>
  createNotifyMessages({
    tx,
    clock,
    config: createConfig({ db: prisma, clock, redis: null }),
    purchaseMode: async () => mode,
  });
async function actor() {
  const user = await make.merchantUser();
  const { identity, session } = await createNotifySessionFixture(prisma, clock, user.id);
  return {
    merchantUserId: user.id,
    wechatIdentityId: identity.id,
    sessionId: session.id,
    storeId: null as string | null,
  };
}

it("未配置真实12槽位不可请求；GET不写通知/额度/会话，默认冷却7/最多3", async () => {
  const input = await actor();
  const before = await Promise.all([
    prisma.wxSubscribeQuota.count(),
    prisma.notification.count(),
    prisma.userSession.findUnique({ where: { id: input.sessionId } }),
  ]);
  const result = await build().settings(input);
  expect(result.items).toHaveLength(12);
  expect(result.items.every((item) => item.tmplId === null && item.state === "unavailable")).toBe(
    true,
  );
  expect(result).toMatchObject({ cooldownDays: 7, maxPerAsk: 3 });
  expect(
    await Promise.all([
      prisma.wxSubscribeQuota.count(),
      prisma.notification.count(),
      prisma.userSession.findUnique({ where: { id: input.sessionId } }),
    ]),
  ).toEqual(before);
});

it("仅当前会话身份额度，真实on/off/rejected/banned；有效场景显示名与槽位配置", async () => {
  const input = await actor();
  const other = await createNotifySessionFixture(prisma, clock, input.merchantUserId);
  for (const slotKey of ["pay_result", "review_result", "todo_remind", "ticket_reply"])
    await prisma.wxTemplateSlot.update({
      where: { slotKey },
      data: { status: "active", providerTemplateId: `fictional-template-${slotKey}`, fields: [] },
    });
  await createNotifyQuotaFixture(prisma, clock, {
    ...input,
    slotKey: "pay_result",
    remaining: 2,
    lastAcceptAt: clock.now(),
  });
  await createNotifyQuotaFixture(prisma, clock, {
    ...input,
    slotKey: "review_result",
    state: "rejected",
  });
  await createNotifyQuotaFixture(prisma, clock, {
    ...input,
    slotKey: "todo_remind",
    state: "banned",
  });
  await createNotifyQuotaFixture(prisma, clock, {
    merchantUserId: input.merchantUserId,
    wechatIdentityId: other.identity.id,
    slotKey: "ticket_reply",
    remaining: 9,
  });
  const result = await build().settings(input);
  expect(result.items.find((item) => item.slotKey === "pay_result")).toMatchObject({
    state: "on",
    estRemaining: 2,
    lastAcceptAt: clock.now().toISOString(),
    tmplId: "fictional-template-pay_result",
    sceneNames: ["付款成功"],
  });
  expect(result.items.find((item) => item.slotKey === "review_result")?.state).toBe("rejected");
  expect(result.items.find((item) => item.slotKey === "todo_remind")?.state).toBe("banned");
  expect(result.items.find((item) => item.slotKey === "ticket_reply")).toMatchObject({
    state: "off",
    estRemaining: 0,
  });
  await prisma.wxTemplateSlot.update({
    where: { slotKey: "pay_result" },
    data: { status: "disabled", disabledReason: "manual" },
  });
  expect(
    (await build().settings(input)).items.find((item) => item.slotKey === "pay_result"),
  ).toMatchObject({ state: "unavailable", tmplId: null, estRemaining: 2 });
});

it("hidden只去掉到期/积分两槽位；无效门店按账号设置，当前主体policy回调才裁剪", async () => {
  const own = await make.merchant();
  const { session, identity } = await createNotifySessionFixture(prisma, clock, own.user.id);
  const input = {
    merchantUserId: own.user.id,
    wechatIdentityId: identity.id,
    sessionId: session.id,
    storeId: own.store.id,
  };
  const hidden = await build("hidden").settings(input);
  expect(hidden.items).toHaveLength(10);
  expect(hidden.items.map((item) => item.slotKey)).not.toContain("svc_expiry");
  expect(hidden.items.map((item) => item.slotKey)).not.toContain("quota_change");
  expect(hidden.items.map((item) => item.slotKey)).toContain("pay_result");
  expect((await build("hidden").settings({ ...input, storeId: "bad" })).items).toHaveLength(12);
  expect((await build("offline_contract").settings(input)).items).toHaveLength(12);
});

it("会话微信身份不匹配/过期/吊销拒绝；身份清空仅允许已吊销会话", async () => {
  const input = await actor();
  await expect(build().settings({ ...input, wechatIdentityId: uuidv7() })).rejects.toMatchObject({
    error: "SESSION_INVALID",
  });
  await prisma.userSession.update({
    where: { id: input.sessionId },
    data: { idleExpiresAt: new Date(clock.now().getTime() + 1) },
  });
  clock.advance(2);
  await expect(build().settings(input)).rejects.toMatchObject({ error: "SESSION_INVALID" });
  await prisma.userSession.update({
    where: { id: input.sessionId },
    data: { wechatIdentityId: null, revokedAt: clock.now(), revokeReason: "logout" },
  });
  await expect(build().settings({ ...input, wechatIdentityId: null })).rejects.toMatchObject({
    error: "SESSION_INVALID",
  });
});

it("预约冷却/每次上限到点真实生效，不写硬编码", async () => {
  const input = await actor();
  const staff = await make.staff();
  const later = new Date(clock.now().getTime() + 1000);
  for (const [key, value] of [
    ["notify.wx.ask_cooldown_days", 14],
    ["notify.wx.max_per_ask", 5],
  ] as const)
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key,
        value,
        effectiveAt: later,
        createdAt: clock.now(),
        createdByStaffId: staff.id,
      },
    });
  expect(await build().settings(input)).toMatchObject({ cooldownDays: 7, maxPerAsk: 3 });
  clock.advance(1000);
  expect(await build().settings(input)).toMatchObject({ cooldownDays: 14, maxPerAsk: 5 });
});

it("notify.wx.enabled真实关闭后所有槽位unavailable，授权额度不被改为0", async () => {
  const input = await actor();
  await prisma.wxTemplateSlot.update({
    where: { slotKey: "asset_feedback" },
    data: { status: "active", providerTemplateId: "fictional-asset-feedback", fields: [] },
  });
  await createNotifyQuotaFixture(prisma, clock, {
    ...input,
    slotKey: "asset_feedback",
    remaining: 3,
  });
  await prisma.featureFlag.update({
    where: { key: "notify.wx.enabled" },
    data: { defaultValue: false },
  });
  const result = await build().settings(input);
  expect(result.items.every((item) => item.state === "unavailable" && item.tmplId === null)).toBe(
    true,
  );
  expect(result.items.find((item) => item.slotKey === "asset_feedback")?.estRemaining).toBe(3);
});
