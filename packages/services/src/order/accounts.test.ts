import type { ChannelAccount, PrismaClient, Store } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import type { Factories } from "../testing/index.js";
import { orderAccounts } from "./accounts.js";

const db = useSeededDatabase("services");
const clock = createClock();
let prisma: PrismaClient;
let make: Factories;
let staffId: string;
beforeAll(async () => {
  prisma = await db.prisma();
  make = createFactories({ db: prisma, clock });
  staffId = (await make.staff({ staffRoleKey: "publisher" })).id;
}, 120_000);

async function account(
  store: Store,
  status = "available",
  platform = "douyin",
): Promise<ChannelAccount> {
  const id = uuidv7();
  const now = clock.now();
  return prisma.channelAccount.create({
    data: {
      id,
      entityId: store.entityId,
      storeId: store.id,
      platform,
      accountName: "订剧账号测试",
      accountUid: id,
      accountUidNorm: id,
      status,
      submittedAt: now,
      ...(status === "available"
        ? { accountType: "personal", verifiedAt: now, verifiedByStaffId: staffId }
        : {}),
      ...(status === "abnormal"
        ? { abnormalSource: "verify", abnormalReasonCode: "test-reason", abnormalNote: "未通过" }
        : {}),
      ...(status === "unbound" ? { unboundAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    },
  });
}

const read = (storeId: string, ids: readonly string[] = []) =>
  createTxRunner({ prisma, appEnv: "test", report: () => {} }).run((tx) =>
    orderAccounts(tx, storeId, ids),
  );

describe("订剧账号的真实门店与状态守卫", { timeout: 60_000 }, () => {
  it("报价保留待核验和异常账号、排除解绑和别店，排序稳定且选择顺序不变", async () => {
    const store = await make.store();
    const otherStore = await make.store({ entityId: store.entityId });
    const wx = await account(store, "available", "wechat_channels");
    const dy = await account(store);
    const pending = await account(store, "pending_verify");
    const abnormal = await account(store, "abnormal");
    await account(store, "unbound");
    await account(otherStore);
    const result = await read(store.id, [wx.id, dy.id]);
    expect(result.selected.map((row) => row.id)).toEqual([wx.id, dy.id]);
    expect(result.available.map((row) => row.id)).toEqual([
      ...[dy.id, pending.id, abnormal.id].sort(),
      wx.id,
    ]);
    expect((await read(store.id)).selected).toEqual([]);
  });

  it("同一主体的别店账号与另一主体账号都不能选，缺失账号也不给额外事实", async () => {
    const store = await make.store();
    const sameEntity = await make.store({ entityId: store.entityId });
    const foreign = await make.store();
    const ids = [(await account(sameEntity)).id, (await account(foreign)).id, uuidv7()];
    for (const id of ids) {
      await expect(read(store.id, [id])).rejects.toMatchObject({
        error: "ORDER_ACCOUNT_INVALID",
        details: { channelAccountId: id, reason: "not_in_store" },
      });
    }
  });

  it.each(["pending_verify", "abnormal", "unbound"])(
    "本店 %s 账号返回 not_available",
    async (status) => {
      const store = await make.store();
      const row = await account(store, status);
      await expect(read(store.id, [row.id])).rejects.toMatchObject({
        error: "ORDER_ACCOUNT_INVALID",
        details: { channelAccountId: row.id, reason: "not_available" },
      });
    },
  );

  it("同平台两账号或重复ID均指向原字段，不会生成重复的订单项账号", async () => {
    const store = await make.store();
    const first = await account(store);
    const second = await account(store);
    for (const ids of [
      [first.id, second.id],
      [first.id, first.id],
    ]) {
      await expect(read(store.id, ids)).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
        details: { fieldErrors: [{ path: "channelAccountIds" }] },
      });
    }
  });
});
