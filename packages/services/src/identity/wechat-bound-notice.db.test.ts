import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { createApproval } from "../approval/index.js";
import { claimDeliveries, consumeDelivery, createEvents } from "../events/index.js";
import type { SubscriberTable } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  uuidv7,
} from "../kernel/index.js";
import type { DeliveredEvent } from "../kernel/index.js";
import { createTenant } from "../tenant/index.js";
import { assembleForTest, useSeededDatabase } from "../testing/index.js";
import {
  buildHarness,
  META,
  nextOpenid,
  nextPhone,
  openClient,
  TEST_APPID,
} from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { deleteAccount } from "./account-deletion.js";
import { onWechatBound } from "./wechat-bound-notice.js";

const db = useSeededDatabase("services", { label: "boundnotice", max: 1 });
const SUBSCRIBER = "identity.onWechatBound",
  TYPE = "merchant_user.wechat_bound";
const assembly = assembleForTest({ entry: "api" });
let h: Harness, events: ReturnType<typeof createEvents>;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
  events = createEvents({ tx: h.tx, clock: h.clock, assembly });
}, 120_000);
async function boundUser() {
  const phone = nextPhone(),
    firstOpenid = nextOpenid();
  const first = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid: firstOpenid }),
    consents: h.consents(),
  });
  const auth = await h.identity.authenticate(first.token, { ip: META.ip });
  if (!auth.ok) throw new Error("登录没有形成当前会话");
  const host = await h.make.merchant();
  const member = await h.make.entityMember({
    entityId: host.entity.id,
    merchantUserId: auth.principal.merchantUserId,
  });
  await h.make.storeMember({
    entityMemberId: member.id,
    storeId: host.store.id,
    addedByMemberId: host.owner.id,
  });
  const second = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid: nextOpenid() }),
    consents: h.consents(),
  });
  const source = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: TYPE, aggregateId: auth.principal.merchantUserId },
  });
  const message: DeliveredEvent = {
    id: source.id,
    type: source.eventType,
    payload: source.payload as Record<string, unknown>,
  };
  return {
    phone,
    firstOpenid,
    first,
    second,
    principal: auth.principal,
    id: auth.principal.merchantUserId,
    source,
    message,
  };
}
async function claim(id: string) {
  await events.expand();
  const refs = await h.tx.run((tx) => claimDeliveries(tx, 200));
  const ref = refs.claimed.find((row) => row.eventId === id && row.subscriber === SUBSCRIBER);
  if (!ref) throw new Error("真实展开/认领未得到本订阅者投递");
  return ref;
}
const alerts = { async raise() {} };
const consume = (ref: Awaited<ReturnType<typeof claim>>, subscribers = events.subscribers) =>
  consumeDelivery({ tx: h.tx, subscribers, alerts }, ref);
function deletionOn(prisma: PrismaClient, who: Awaited<ReturnType<typeof boundUser>>) {
  const tx = createTxRunner({ prisma, appEnv: "test" }),
    localEvents = createEvents({ tx, clock: h.clock, assembly });
  const flow = createFlow({ assembly, clock: h.clock, events: localEvents });
  const approval = createApproval({
    assembly,
    clock: h.clock,
    flow,
    events: localEvents,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const tenant = createTenant({ tx, clock: h.clock, flow, assembly });
  return deleteAccount(
    { tx, clock: h.clock, flow, tenant, approval, appid: TEST_APPID },
    who.principal,
    META,
    { hasConfirmed: true },
  );
}

describe("identity.onWechatBound真实订阅", { timeout: 120_000 }, () => {
  it("真实phoneLogin事件经展开/认领/consume落提示和done，时间取原事件，me只含正式提示字段", async () => {
    const who = await boundUser();
    expect(await h.prisma.merchantUserNotice.count({ where: { merchantUserId: who.id } })).toBe(0);
    h.clock.advance(3600000);
    const ref = await claim(who.source.id);
    expect(await consume(ref)).toBe("done");
    const row = await h.prisma.merchantUserNotice.findUniqueOrThrow({
      where: { id: who.source.id },
    });
    expect(row).toMatchObject({
      merchantUserId: who.id,
      kind: "new_wechat_bound",
      occurredAt: who.source.occurredAt,
      ackedAt: null,
    });
    expect(
      await h.prisma.outboxDelivery.findFirstOrThrow({
        where: { outboxEventId: who.source.id, subscriber: SUBSCRIBER },
      }),
    ).toMatchObject({ status: "done" });
    const notices = (await h.identity.me(who.id)).notices;
    expect(notices).toEqual([
      expect.objectContaining({
        userNoticeId: row.id,
        kind: "new_wechat_bound",
        occurredAt: who.source.occurredAt.toISOString(),
      }),
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/openid|wechatIdentityId|phoneEnc|payload/);
  });
  it("重复消费不新增；ack之后即使直接重投原事件也保留首次ack时间且不重新展示", async () => {
    const who = await boundUser(),
      ref = await claim(who.source.id);
    expect(await consume(ref)).toBe("done");
    expect(await consume(ref)).toBe("stale");
    const ack = await h.identity.acknowledgeUserNotice(who.principal, META, {
      userNoticeId: who.source.id,
    });
    const row = await h.prisma.merchantUserNotice.findUniqueOrThrow({
      where: { id: who.source.id },
    });
    h.clock.advance(1000);
    await h.tx.run((tx) => onWechatBound(tx, who.message));
    expect(
      await h.prisma.merchantUserNotice.findUniqueOrThrow({ where: { id: who.source.id } }),
    ).toEqual(row);
    expect(row.ackedAt?.toISOString()).toBe(ack.ackedAt);
    expect(await h.prisma.merchantUserNotice.count({ where: { merchantUserId: who.id } })).toBe(1);
    expect((await h.identity.me(who.id)).notices).toEqual([]);
  });
  it("拒绝不存在/伪造载荷/错误事件或外人actor的持久化来源，不给被冒用者创建提示", async () => {
    const who = await boundUser();
    for (const message of [
      { ...who.message, id: uuidv7() },
      { ...who.message, type: "merchant_user.registered" },
      { ...who.message, payload: { ...who.message.payload, wechatIdentityId: uuidv7() } },
    ])
      await expect(h.tx.run((tx) => onWechatBound(tx, message))).rejects.toThrow();
    const attacker = await h.make.merchantUser();
    const ctx = createIdentityContext({
      actor: { type: "merchant", id: attacker.id, client: "weapp" },
    });
    const forged = await h.tx.run((tx) =>
      events.emit(tx, ctx, {
        type: TYPE,
        aggregate: { type: "merchant_user", id: who.id },
        payload: who.message.payload as { v: 1; merchantUserId: string; wechatIdentityId: string },
      }),
    );
    if (!forged.id) throw new Error("伪造来源事件未写入");
    const forgedId = forged.id;
    await expect(
      h.tx.run((tx) => onWechatBound(tx, { ...who.message, id: forgedId })),
    ).rejects.toThrow("持久化来源不符");
    expect(await h.prisma.merchantUserNotice.count({ where: { merchantUserId: who.id } })).toBe(0);
  });
  it("消费后续失败同时回滚提示与done；正式重试只生成一行", async () => {
    const who = await boundUser(),
      ref = await claim(who.source.id),
      real = events.subscribers;
    const failing: SubscriberTable = {
      ...real,
      get: (name) => {
        const subscriber = real.get(name);
        return name === SUBSCRIBER && subscriber
          ? {
              ...subscriber,
              handle: async (tx, event) => {
                await subscriber.handle(tx, event);
                throw new Error("lyxtest notice rollback");
              },
            }
          : subscriber;
      },
    };
    expect(await consume(ref, failing)).toBe("retry");
    expect(await h.prisma.merchantUserNotice.count({ where: { merchantUserId: who.id } })).toBe(0);
    expect(
      await h.prisma.outboxDelivery.findFirstOrThrow({
        where: { outboxEventId: who.source.id, subscriber: SUBSCRIBER },
      }),
    ).toMatchObject({ status: "retry", attempts: 1 });
    await h.prisma.outboxDelivery.updateMany({
      where: { outboxEventId: who.source.id, subscriber: SUBSCRIBER },
      data: { nextAttemptAt: new Date(0) },
    });
    expect(await consume(await claim(who.source.id))).toBe("done");
    expect(await h.prisma.merchantUserNotice.count({ where: { merchantUserId: who.id } })).toBe(1);
  });
  it("disabled延迟真实事件保留且enable后可见；已注销账号消费不复活已清提示", async () => {
    const disabled = await boundUser();
    await h.prisma.merchantUser.update({
      where: { id: disabled.id },
      data: { status: "disabled" },
    });
    expect(await consume(await claim(disabled.source.id))).toBe("done");
    expect(
      await h.prisma.merchantUserNotice.count({ where: { merchantUserId: disabled.id } }),
    ).toBe(1);
    expect(await h.identity.authenticate(disabled.first.token, { ip: META.ip })).toMatchObject({
      ok: false,
    });
    await h.prisma.merchantUser.update({ where: { id: disabled.id }, data: { status: "active" } });
    const enabled = await h.identity.phoneLogin(META, {
      ...h.codes({ phone: disabled.phone, openid: disabled.firstOpenid }),
      consents: h.consents(),
    });
    expect(enabled.me.notices).toEqual([
      expect.objectContaining({ userNoticeId: disabled.source.id }),
    ]);
    const deleted = await boundUser();
    await deletionOn(h.prisma, deleted);
    expect(await consume(await claim(deleted.source.id))).toBe("done");
    expect(await h.prisma.merchantUserNotice.count({ where: { merchantUserId: deleted.id } })).toBe(
      0,
    );
  });
  it("两max1客户端消费与真实注销竞争3轮，最终账号deleted且提示为零", async () => {
    const clients = await Promise.all([openClient(db, { max: 1 }), openClient(db, { max: 1 })]);
    const tx = createTxRunner({ prisma: clients[0]!, appEnv: "test" });
    try {
      for (let round = 0; round < 3; round++) {
        const who = await boundUser();
        await Promise.all([
          tx.run((handle) => onWechatBound(handle, who.message)),
          deletionOn(clients[1]!, who),
        ]);
        expect(
          await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: who.id } }),
        ).toMatchObject({ status: "deleted" });
        expect(await h.prisma.merchantUserNotice.count({ where: { merchantUserId: who.id } })).toBe(
          0,
        );
      }
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });
});
