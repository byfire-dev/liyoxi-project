import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { snapshotTables, useSeededDatabase } from "../testing/index.js";
import * as identity from "./index.js";
import { buildHarness, META, nextPhone, TEST_APPID } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";

const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 90_000);
afterAll(async () => {
  await h?.prisma.$disconnect();
});

const input = (merchantUserId: string, appid = TEST_APPID) => ({
  merchantUserId,
  appid,
  now: h.clock.now(),
});
let sequence = 0;
async function login() {
  sequence++;
  const openid = `fictional_lookup_${sequence}`;
  await h.identity.phoneLogin(META, {
    ...h.codes({ openid, phone: nextPhone() }),
    consents: h.consents(),
  });
  return h.prisma.wechatIdentity.findUniqueOrThrow({
    where: { appid_openid: { appid: TEST_APPID, openid } },
  });
}

// Alternate app/clock fixtures are inserted, never mutate the immutable binding columns.
async function additionalIdentity(
  merchantUserId: string,
  options: {
    appid?: string;
    lastActiveAt?: Date;
    lastLoginAt?: Date;
    silentLoginEnabled?: boolean;
  } = {},
) {
  const now = h.clock.now();
  return h.prisma.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId,
      appid: options.appid ?? TEST_APPID,
      openid: `fictional_extra_${++sequence}`,
      unionid: null,
      silentLoginEnabled: options.silentLoginEnabled ?? true,
      lastActiveAt: options.lastActiveAt ?? now,
      lastLoginAt: options.lastLoginAt ?? now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

it("自然键仅返回对应身份id，不跨AppID或混用未知openid", async () => {
  const row = await login();
  const other = await additionalIdentity(row.merchantUserId, { appid: "wx_fictional_other" });
  await h.tx.run(async (tx) => {
    expect(await identity.findWechatIdentityId(tx, { appid: TEST_APPID, openid: row.openid })).toBe(
      row.id,
    );
    expect(
      await identity.findWechatIdentityId(tx, { appid: other.appid, openid: other.openid }),
    ).toBe(other.id);
    expect(
      await identity.findWechatIdentityId(tx, { appid: other.appid, openid: row.openid }),
    ).toBeNull();
    expect(
      await identity.findWechatIdentityId(tx, { appid: TEST_APPID, openid: "fictional_missing" }),
    ).toBeNull();
  });
});

it("绑定移除后自然键返回null，不缓存旧id", async () => {
  const userIdentity = await login();
  const row = await additionalIdentity(userIdentity.merchantUserId);
  await h.tx.run(async (tx) => {
    expect(await identity.findWechatIdentityId(tx, { appid: row.appid, openid: row.openid })).toBe(
      row.id,
    );
    await tx.wechatIdentity.delete({ where: { id: row.id } });
    expect(
      await identity.findWechatIdentityId(tx, { appid: row.appid, openid: row.openid }),
    ).toBeNull();
  });
});

it("自然键映射不附加active/silent限制；recent必须当前active", async () => {
  const row = await login();
  await h.prisma.wechatIdentity.update({
    where: { id: row.id },
    data: { silentLoginEnabled: false },
  });
  await h.tx.run(async (tx) => {
    expect(await identity.findWechatIdentityId(tx, { appid: row.appid, openid: row.openid })).toBe(
      row.id,
    );
    expect(await identity.recentWechatOpenid(tx, input(row.merchantUserId))).toEqual({
      wechatIdentityId: row.id,
      openid: row.openid,
    });
  });
  const disabled = await h.make.merchantUser({ status: "disabled" });
  const disabledIdentity = await additionalIdentity(disabled.id, { silentLoginEnabled: false });
  await h.tx.run(async (tx) => {
    expect(
      await identity.findWechatIdentityId(tx, {
        appid: disabledIdentity.appid,
        openid: disabledIdentity.openid,
      }),
    ).toBe(disabledIdentity.id);
    expect(await identity.recentWechatOpenid(tx, input(disabled.id))).toBeNull();
  });
});

it("recent按lastActiveAt挑同账号同AppID，不按lastLoginAt或其他账号", async () => {
  const row = await login();
  const chosen = await additionalIdentity(row.merchantUserId, {
    lastActiveAt: new Date(h.clock.now().getTime() + 1),
    lastLoginAt: new Date(h.clock.now().getTime() - 7_200_001),
  });
  await additionalIdentity(row.merchantUserId, {
    appid: "wx_fictional_other",
    lastActiveAt: new Date(h.clock.now().getTime() + 2),
  });
  await login();
  expect(
    await h.tx.run((tx) => identity.recentWechatOpenid(tx, input(row.merchantUserId))),
  ).toEqual({ wechatIdentityId: chosen.id, openid: chosen.openid });
});

it("近两小时恰等号命中，过界1ms和未知账号返回null", async () => {
  const row = await login();
  const boundary = new Date(h.clock.now().getTime() - 7_200_000);
  await h.prisma.wechatIdentity.update({ where: { id: row.id }, data: { lastActiveAt: boundary } });
  expect(
    await h.tx.run((tx) => identity.recentWechatOpenid(tx, input(row.merchantUserId))),
  ).toEqual({ wechatIdentityId: row.id, openid: row.openid });
  await h.prisma.wechatIdentity.update({
    where: { id: row.id },
    data: { lastActiveAt: new Date(boundary.getTime() - 1) },
  });
  expect(
    await h.tx.run((tx) => identity.recentWechatOpenid(tx, input(row.merchantUserId))),
  ).toBeNull();
  expect(await h.tx.run((tx) => identity.recentWechatOpenid(tx, input(uuidv7())))).toBeNull();
});

it("同活跃时刻按id升序稳定取唯一行；账号无本AppID身份返回null", async () => {
  const row = await login();
  const later = await additionalIdentity(row.merchantUserId);
  const expected = [row, later].sort((a, b) => a.id.localeCompare(b.id))[0]!;
  expect(
    await h.tx.run((tx) => identity.recentWechatOpenid(tx, input(row.merchantUserId))),
  ).toEqual({ wechatIdentityId: expected.id, openid: expected.openid });
  expect(
    await h.tx.run((tx) =>
      identity.recentWechatOpenid(tx, input(row.merchantUserId, "wx_fictional_absent")),
    ),
  ).toBeNull();
});

it("已注销的空账号没有recent目标", async () => {
  const user = await h.make.merchantUser({
    status: "deleted",
    phoneEnc: null,
    phoneBidx: null,
    phoneMask: null,
    phoneLast4: null,
    displayName: null,
    deletedAt: h.clock.now(),
  });
  expect(await h.tx.run((tx) => identity.recentWechatOpenid(tx, input(user.id)))).toBeNull();
});

it("两个口零DML/外呼，recent仅一次固定参数化SELECT", async () => {
  const row = await login();
  const tables = [
    "merchant_user",
    "wechat_identity",
    "user_session",
    "audit_log",
    "outbox_event",
    "agreement_consent",
  ];
  const before = await snapshotTables(h.prisma, tables);
  const calls = h.wechat.calls.length;
  await h.tx.run(async (tx) => {
    const select = vi.spyOn(tx, "$queryRawUnsafe");
    try {
      expect(
        await identity.findWechatIdentityId(tx, { appid: row.appid, openid: row.openid }),
      ).toBe(row.id);
      expect(await identity.recentWechatOpenid(tx, input(row.merchantUserId))).toEqual({
        wechatIdentityId: row.id,
        openid: row.openid,
      });
      expect(select).toHaveBeenCalledOnce();
      const [sql, merchantUserId, appid, at] = select.mock.calls[0]!;
      expect(sql).toContain("LIMIT 1");
      expect(sql).not.toMatch(/FOR UPDATE|INSERT|UPDATE|DELETE/i);
      expect([merchantUserId, appid, at]).toEqual([
        row.merchantUserId,
        row.appid,
        new Date(h.clock.now().getTime() - 7_200_000),
      ]);
    } finally {
      select.mockRestore();
    }
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  expect(h.wechat.calls).toHaveLength(calls);
});
