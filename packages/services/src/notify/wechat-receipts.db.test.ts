import { createPrismaClient } from "@liyoxi/db";
import type { Prisma, PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import {
  createClock,
  createFactories,
  createNotifyMessageFixture,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import * as notify from "./index.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T08:00:00Z"));
const ctx = createIdentityContext({ actor: { type: "system", job: "webhook.reprocess" } });
const logs: Readonly<Record<string, unknown>>[] = [];
let prisma: PrismaClient;
let second: PrismaClient;
let tx: ReturnType<typeof createTxRunner>;
let tx2: ReturnType<typeof createTxRunner>;
let make: ReturnType<typeof createFactories>;
const templateId = "fictional-receipt-template";
const slots = ["review_result", "ticket_reply"] as const;
beforeAll(async () => {
  prisma = await db.prisma();
  second = createPrismaClient({ connectionString: await db.url(), max: 1 });
  tx = createTxRunner({ prisma, appEnv: "test" });
  tx2 = createTxRunner({ prisma: second, appEnv: "test" });
  make = createFactories({ db: prisma, clock });
  for (const slotKey of slots)
    await prisma.wxTemplateSlot.update({
      where: { slotKey },
      data: {
        providerTemplateId: templateId,
        status: "active",
        fields: [],
        updatedAt: clock.now(),
      },
    });
});
afterAll(async () => {
  await second?.$disconnect();
});
async function identity(merchantUserId?: string, openid = `fictional-${uuidv7()}`) {
  return prisma.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId: merchantUserId ?? (await make.merchantUser()).id,
      appid: "wxfictionalreceipts",
      openid,
      lastLoginAt: clock.now(),
      lastActiveAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
}
async function delivery(
  owner: Awaited<ReturnType<typeof identity>>,
  extra: Partial<Prisma.NotificationDeliveryUncheckedCreateInput> = {},
) {
  const message = await createNotifyMessageFixture(prisma, clock, {
    merchantUserId: owner.merchantUserId,
  });
  return prisma.notificationDelivery.create({
    data: {
      id: uuidv7(),
      notificationId: message.notificationId,
      isDirect: false,
      channel: "wx_subscribe",
      origin: "primary",
      status: "sent",
      dueAt: clock.now(),
      attemptNo: 1,
      targetRef: owner.id,
      providerTemplateId: templateId,
      providerMsgId: `fictional-${uuidv7()}`,
      sentAt: clock.now(),
      finishedAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...extra,
    },
  });
}
async function quota(
  owner: Awaited<ReturnType<typeof identity>>,
  slotKey: string = slots[0],
  state = "ok",
) {
  return prisma.wxSubscribeQuota.create({
    data: {
      wechatIdentityId: owner.id,
      wxTemplateSlotKey: slotKey,
      merchantUserId: owner.merchantUserId,
      state,
      estRemaining: state === "ok" ? 2 : 0,
      lastAcceptAt: clock.now(),
      lastSendAt: clock.now(),
      lastErrorCode: "fictional",
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
  });
}
const receipt = (ownerId: string, row: Awaited<ReturnType<typeof delivery>>, errorCode = "0") => ({
  event: "subscribe_msg_sent_event" as const,
  wechatIdentityId: ownerId,
  items: [{ templateId, msgId: row.providerMsgId!, errorCode }],
  receivedAt: new Date("2026-09-08T00:00:00Z"),
});
function handler(at = clock) {
  return notify.createWechatReceiptHandler({
    clock: at,
    logger: { info: (fields) => logs.push(fields) },
  });
}
const read = (id: string) => prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });
const readQuota = (owner: Awaited<ReturnType<typeof identity>>, slotKey: string = slots[0]) =>
  prisma.wxSubscribeQuota.findUniqueOrThrow({
    where: {
      wechatIdentityId_wxTemplateSlotKey: {
        wechatIdentityId: owner.id,
        wxTemplateSlotKey: slotKey,
      },
    },
  });

it("冷回执按持久收到时间追加0和失败码，仅改两回执列", async () => {
  const owner = await identity();
  for (const errorCode of ["0", "43101"]) {
    const row = await delivery(owner);
    const input = receipt(owner.id, row, errorCode);
    expect(await tx.run((t) => handler()(t, input, ctx))).toBe("processed");
    expect(await read(row.id)).toEqual({
      ...row,
      receiptStatus: errorCode,
      receiptReportedAt: input.receivedAt,
    });
  }
});

it("同回执重放和矛盾后到回执均不覆盖首次二元组", async () => {
  const owner = await identity(),
    row = await delivery(owner);
  const input = receipt(owner.id, row);
  await tx.run((t) => handler()(t, input, ctx));
  const first = await read(row.id);
  expect(await tx.run((t) => handler()(t, input, ctx))).toBe("ignored");
  expect(
    await tx.run((t) =>
      handler()(
        t,
        {
          ...input,
          items: [{ templateId, msgId: row.providerMsgId!, errorCode: "43101" }],
          receivedAt: clock.now(),
        },
        ctx,
      ),
    ),
  ).toBe("ignored");
  expect(await read(row.id)).toEqual(first);
});

it("optional消息id/结果码缺失或超列限不伪造成功", async () => {
  const owner = await identity(),
    row = await delivery(owner);
  const input = receipt(owner.id, row);
  for (const items of [
    [{ templateId }],
    [{ templateId, msgId: row.providerMsgId! }],
    [{ templateId, errorCode: "0" }],
    [{ templateId, msgId: row.providerMsgId!, errorCode: "1".repeat(17) }],
  ]) {
    expect(await tx.run((t) => handler()(t, { ...input, items }, ctx))).toBe("ignored");
  }
  expect(await read(row.id)).toEqual(row);
});

it("同消息号不跨channel/identity/template或通知收件人", async () => {
  const owner = await identity(),
    foreign = await identity();
  const good = await delivery(owner);
  const others = await Promise.all([
    delivery(owner, { channel: "inbox", providerMsgId: good.providerMsgId }),
    delivery(foreign, { providerMsgId: good.providerMsgId }),
    delivery(owner, { providerTemplateId: "fictional-other", providerMsgId: good.providerMsgId }),
    delivery(foreign, { targetRef: owner.id, providerMsgId: good.providerMsgId }),
  ]);
  await tx.run((t) => handler()(t, receipt(owner.id, good), ctx));
  expect((await read(good.id)).receiptStatus).toBe("0");
  for (const row of others) expect(await read(row.id)).toEqual(row);
});

it("未知消息/模板与测试HMAC目标不能放宽归属匹配", async () => {
  const owner = await identity();
  const row = await delivery(owner, {
    targetRef: "f".repeat(64),
    notificationId: null,
    isDirect: true,
    origin: "direct",
    purpose: "test",
  });
  const base = receipt(owner.id, row);
  for (const input of [
    base,
    { ...base, items: [{ templateId: "unknown", msgId: row.providerMsgId!, errorCode: "0" }] },
    { ...base, items: [{ templateId, msgId: "unknown", errorCode: "0" }] },
  ])
    expect(await tx.run((t) => handler()(t, input, ctx))).toBe("ignored");
  expect(await read(row.id)).toEqual(row);
});

it("change清全部真实映射既有额度、不要求optional状态、不碰历史", async () => {
  const owner = await identity(),
    other = await identity();
  const rows = await Promise.all(slots.map((slotKey) => quota(owner, slotKey)));
  const outside = await quota(other);
  const at = createClock(new Date(clock.now().getTime() + 1000));
  const input = {
    event: "subscribe_msg_change_event" as const,
    wechatIdentityId: owner.id,
    items: [{ templateId }],
    receivedAt: clock.now(),
  };
  expect(await tx.run((t) => handler(at)(t, input, ctx))).toBe("processed");
  for (const row of rows)
    expect(await readQuota(owner, row.wxTemplateSlotKey)).toEqual({
      ...row,
      state: "rejected",
      estRemaining: 0,
      updatedAt: at.now(),
    });
  expect(await readQuota(other)).toEqual(outside);
  expect(
    await tx.run((t) => handler(createClock(new Date(at.now().getTime() + 1000)))(t, input, ctx)),
  ).toBe("ignored");
  for (const row of rows)
    expect((await readQuota(owner, row.wxTemplateSlotKey)).updatedAt).toEqual(at.now());
});

it("change未知模板/无额度不建行，banned既有行按正式关闭", async () => {
  const owner = await identity();
  const input = {
    event: "subscribe_msg_change_event" as const,
    wechatIdentityId: owner.id,
    items: [{ templateId: "unknown" }, { templateId }],
    receivedAt: clock.now(),
  };
  const before = await prisma.wxSubscribeQuota.count();
  expect(await tx.run((t) => handler()(t, input, ctx))).toBe("ignored");
  expect(await prisma.wxSubscribeQuota.count()).toBe(before);
  await quota(owner, slots[0], "banned");
  expect(await tx.run((t) => handler()(t, input, ctx))).toBe("processed");
  expect(await readQuota(owner)).toMatchObject({ state: "rejected", estRemaining: 0 });
});

it("删除改绑旧identity后的回执不转向相同openid新身份/新quota", async () => {
  const old = await identity(),
    row = await delivery(old);
  await quota(old);
  await prisma.wechatIdentity.delete({ where: { id: old.id } });
  const replacement = await identity(undefined, old.openid),
    fresh = await quota(replacement);
  expect(await tx.run((t) => handler()(t, receipt(old.id, row), ctx))).toBe("ignored");
  expect(
    await tx.run((t) =>
      handler()(
        t,
        {
          event: "subscribe_msg_change_event",
          wechatIdentityId: old.id,
          items: [{ templateId }],
          receivedAt: clock.now(),
        },
        ctx,
      ),
    ),
  ).toBe("ignored");
  expect(await read(row.id)).toEqual(row);
  expect(await readQuota(replacement)).toEqual(fresh);
  expect(await prisma.wxSubscribeQuota.count({ where: { wechatIdentityId: old.id } })).toBe(0);
});

it("popup仅固定事件与整数日志，原文不进入日志或表", async () => {
  const owner = await identity();
  const tables = [
    "notification",
    "notification_delivery",
    "wx_subscribe_quota",
    "wechat_identity",
    "audit_log",
    "outbox_event",
  ];
  const before = await snapshotTables(prisma, tables),
    start = logs.length;
  expect(
    await tx.run((t) =>
      handler()(
        t,
        {
          event: "subscribe_msg_popup_event",
          wechatIdentityId: owner.id,
          items: [
            {
              templateId: "sensitive-template",
              errorStatus: "raw-secret",
              popupScene: "raw-scene",
            },
          ],
          receivedAt: clock.now(),
        },
        ctx,
      ),
    ),
  ).toBe("processed");
  expect(await snapshotTables(prisma, tables)).toEqual(before);
  const observed = JSON.stringify(logs.slice(start));
  for (const secret of [owner.openid, owner.id, "sensitive-template", "raw-secret", "raw-scene"])
    expect(observed).not.toContain(secret);
  expect(logs.at(-1)).toMatchObject({ event: "subscribe_msg_popup_event", itemCount: 1 });
});

it("两个真实连接重复sent恰一首写、二元组/发送字段保持", async () => {
  const owner = await identity(),
    row = await delivery(owner),
    input = receipt(owner.id, row);
  const outcomes = await Promise.all([
    tx.run((t) => handler()(t, input, ctx)),
    tx2.run((t) => handler()(t, input, ctx)),
  ]);
  expect(outcomes.sort()).toEqual(["ignored", "processed"]);
  expect(await read(row.id)).toEqual({
    ...row,
    receiptStatus: "0",
    receiptReportedAt: input.receivedAt,
  });
});

it("两个连接矛盾回执不混合首次码/时间", async () => {
  const owner = await identity(),
    row = await delivery(owner);
  const a = receipt(owner.id, row),
    b = { ...receipt(owner.id, row, "43101"), receivedAt: clock.now() };
  const outcomes = await Promise.all([
    tx.run((t) => handler()(t, a, ctx)),
    tx2.run((t) => handler()(t, b, ctx)),
  ]);
  expect(outcomes.sort()).toEqual(["ignored", "processed"]);
  const actual = await read(row.id);
  const accepted = actual.receiptStatus === "0" ? a : b;
  expect(actual).toEqual({
    ...row,
    receiptStatus: accepted.items[0]!.errorCode,
    receiptReportedAt: accepted.receivedAt,
  });
});

it("两连接重复change只有一次真变更、不覆盖首updatedAt", async () => {
  const owner = await identity(),
    row = await quota(owner);
  const a = createClock(new Date(clock.now().getTime() + 1000)),
    b = createClock(new Date(clock.now().getTime() + 2000));
  const input = {
    event: "subscribe_msg_change_event" as const,
    wechatIdentityId: owner.id,
    items: [{ templateId }],
    receivedAt: clock.now(),
  };
  const outcomes = await Promise.all([
    tx.run((t) => handler(a)(t, input, ctx)),
    tx2.run((t) => handler(b)(t, input, ctx)),
  ]);
  expect(outcomes.sort()).toEqual(["ignored", "processed"]);
  const actual = await readQuota(owner);
  expect([a.now().getTime(), b.now().getTime()]).toContain(actual.updatedAt.getTime());
  expect(actual).toEqual({
    ...row,
    state: "rejected",
    estRemaining: 0,
    updatedAt: actual.updatedAt,
  });
});
