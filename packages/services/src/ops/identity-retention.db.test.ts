import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import { createTxRunner, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { runRetention } from "./retention.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  useSeededDatabase,
} from "../testing/index.js";
const cleanupAssembly = assembleForTest({ entry: "worker" });
function cleanup(name: string) {
  const item = cleanupAssembly.cleanup(name);
  if (!item) throw new Error(`未登记清理项：${name}`);
  return item.run;
}
const purgePortalSessions = cleanup("identity.portal_session");
const purgeSmsVerifications = cleanup("identity.sms_verification");
const purgeUserSessions = cleanup("identity.user_session");

const db = useSeededDatabase("services", { label: "idretention", max: 1 });
const clock = createClock(),
  DAY = 86_400_000;
const at = (days: number, ms = 0) => new Date(clock.now().getTime() + days * DAY + ms);
let prisma: PrismaClient, tx: TxRunner;
let own: Awaited<ReturnType<ReturnType<typeof createFactories>["merchant"]>>;
let identityId: string;
beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  own = await createFactories({ db: prisma, clock }).merchant();
  identityId = (
    await prisma.wechatIdentity.create({
      data: {
        id: uuidv7(),
        merchantUserId: own.user.id,
        appid: "lyxtest-retention",
        openid: "fictional-retention",
        silentLoginEnabled: true,
        createdAt: at(-120),
        updatedAt: at(-120),
        lastLoginAt: at(-120),
        lastActiveAt: at(-120),
      },
    })
  ).id;
}, 120_000);

async function session(input: { absolute?: Date; idle?: Date; revoked?: Date }) {
  return prisma.userSession.create({
    data: {
      id: uuidv7(),
      merchantUserId: own.user.id,
      wechatIdentityId: identityId,
      tokenHash: new Uint8Array(32),
      createdAt: at(-120),
      updatedAt: at(-120),
      lastSeenAt: at(-120),
      lastIp: "192.0.2.19",
      absoluteExpiresAt: input.absolute ?? at(1),
      idleExpiresAt: input.idle ?? at(1),
      ...(input.revoked ? { revokedAt: input.revoked, revokeReason: "admin" } : {}),
    },
  });
}
async function portal(expiresAt: Date, revokedAt?: Date) {
  const id = uuidv7();
  return prisma.portalSession.create({
    data: {
      id,
      tokenHash: Buffer.from(id.replaceAll("-", "").repeat(2), "hex"),
      portalTicketId: uuidv7(),
      approvedByUserId: own.user.id,
      entityId: own.entity.id,
      storeId: own.store.id,
      grantScope: "store",
      createdAt: at(-120),
      updatedAt: at(-120),
      expiresAt,
      ip: "192.0.2.19",
      userAgent: "lyxtest-retention",
      ...(revokedAt ? { revokedAt, revokeReason: "account_action" } : {}),
    },
  });
}
async function sms(expiresAt: Date, used = false) {
  return prisma.smsVerification.create({
    data: {
      id: uuidv7(),
      purpose: "phone_change",
      merchantUserId: own.user.id,
      phoneBidx: new Uint8Array(32),
      codeHash: new Uint8Array(32),
      expiresAt,
      createdAt: at(-20),
      updatedAt: at(-20),
      ...(used ? { usedAt: at(-19) } : {}),
    },
  });
}
const ctx = () => ({ now: clock.now(), limit: 100 });

describe("identity真实过期凭据清理", { timeout: 120_000 }, () => {
  it("商家会话按空闲、绝对过期或吊销超过30天清理，边界和有效行保留", async () => {
    const old = [
      await session({ absolute: at(-30, -1) }),
      await session({ idle: at(-30, -1) }),
      await session({ revoked: at(-30, -1) }),
    ];
    const keep = [
      await session({ absolute: at(-30) }),
      await session({ idle: at(-30) }),
      await session({ revoked: at(-30) }),
      await session({}),
    ];
    expect(await tx.run((handle) => purgeUserSessions(handle, ctx()))).toBe(3);
    expect(
      await prisma.userSession.count({ where: { id: { in: old.map((row) => row.id) } } }),
    ).toBe(0);
    expect(await prisma.userSession.findMany({ orderBy: { id: "asc" } })).toEqual(
      keep.sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
  it("下载会话同30天线；短信仅按过期7天清理，已使用不能提前删且账号/身份/门店不变", async () => {
    await portal(at(-30, -1));
    await portal(at(1), at(-30, -1));
    const keepPortal = [await portal(at(-30)), await portal(at(1), at(-30)), await portal(at(1))];
    await sms(at(-7, -1));
    const keepSms = [await sms(at(-7)), await sms(at(-1), true), await sms(at(1))];
    expect(await tx.run((handle) => purgePortalSessions(handle, ctx()))).toBe(2);
    expect(await tx.run((handle) => purgeSmsVerifications(handle, ctx()))).toBe(1);
    expect(await prisma.portalSession.findMany({ orderBy: { id: "asc" } })).toEqual(
      keepPortal.sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await prisma.smsVerification.findMany({ orderBy: { id: "asc" } })).toEqual(
      keepSms.sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await prisma.merchantUser.findUniqueOrThrow({ where: { id: own.user.id } })).toEqual(
      own.user,
    );
    expect(await prisma.store.findUniqueOrThrow({ where: { id: own.store.id } })).toEqual(
      own.store,
    );
    expect(await prisma.wechatIdentity.count({ where: { id: identityId } })).toBe(1);
  });
  it("正式每日注册通过既有调度限量续清，事务失败不丢数据", async () => {
    const full = assembleForTest({ entry: "worker" });
    const cleanups = full.cleanups.filter((item) => item.module === "identity");
    expect(cleanups.map((item) => [item.name, item.every]).sort()).toEqual([
      ["identity.portal_session", "day"],
      ["identity.sms_verification", "day"],
      ["identity.user_session", "day"],
    ]);
    for (let index = 0; index < 6; index++) await sms(at(-8));
    const deps = {
      assembly: { cleanups },
      clock,
      alerts: {
        async raise() {
          throw new Error("不应有清理错误");
        },
      },
    };
    const run = (scheduledFor: Date) =>
      tx.run((handle) => runRetention(handle, deps, { scheduledFor, limit: 1 }));
    expect((await run(new Date("2026-01-05T04:00:00Z"))).rows).toEqual({});
    await expect(
      tx.run(async (handle) => {
        expect(await purgeSmsVerifications(handle, ctx())).toBe(6);
        throw new Error("lyxtest retention rollback");
      }),
    ).rejects.toThrow("lyxtest retention rollback");
    const midnight = new Date("2026-01-05T16:00:00Z");
    expect(await run(midnight)).toEqual({
      daily: true,
      rows: {
        "identity.portal_session": 0,
        "identity.sms_verification": 5,
        "identity.user_session": 0,
      },
      failed: {},
    });
    expect((await run(midnight)).rows["identity.sms_verification"]).toBe(1);
    expect((await run(midnight)).rows["identity.sms_verification"]).toBe(0);
  });
});
