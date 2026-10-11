import { beforeAll, describe, expect, it, vi } from "vitest";

import { assertCurrentSession } from "../index.js";
import type { Tx, TxRunOptions } from "../kernel/index.js";
import { uuidv7 } from "../kernel/index.js";
import { assertSnapshotsEqual, snapshotTables, useSeededDatabase } from "../testing/index.js";
import {
  buildHarness,
  META,
  nextOpenid,
  nextPhone,
  openClient,
  TEST_APPID,
} from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import type { SessionPrincipal } from "./index.js";

const db = useSeededDatabase("services", { label: "currsession" });
const SLOW = 60_000;
const TABLES = [
  "merchant_user",
  "wechat_identity",
  "user_session",
  "portal_session",
  "agreement_consent",
  "auth_event",
  "audit_log",
  "outbox_event",
];
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 120_000);

async function register(input: { phone?: string; openid?: string } = {}) {
  const phone = input.phone ?? nextPhone();
  const openid = input.openid ?? nextOpenid();
  const result = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid }),
    consents: h.consents(),
  });
  const checked = await h.identity.authenticate(result.token, { ip: META.ip });
  if (!checked.ok) throw new Error("公开登录应产生有效会话");
  return { phone, openid, principal: checked.principal };
}
const read = (principal: SessionPrincipal, now = h.clock.now(), appid = TEST_APPID) =>
  h.tx.run((tx) => assertCurrentSession(tx, principal, now, appid));
const invalid = (run: Promise<unknown>) =>
  expect(run).rejects.toMatchObject({ error: "SESSION_INVALID" });
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("会话快照栅栏超时")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("调用方事务内的当前会话事实", () => {
  it(
    "单条参数化 JOIN、精确四字段且跨日重复读取完全零写",
    async () => {
      const { principal } = await register();
      const before = await snapshotTables(h.prisma, TABLES);
      const at = new Date(h.clock.now().getTime() + 86400000);
      await h.tx.run(async (tx) => {
        const sql = vi.spyOn(tx, "$queryRaw");
        try {
          expect(await assertCurrentSession(tx, principal, at, TEST_APPID)).toEqual(principal);
          expect(sql).toHaveBeenCalledTimes(1);
          const query = String(sql.mock.calls[0]![0]);
          expect(query).toContain("JOIN merchant_user");
          expect(query).toContain("JOIN wechat_identity");
          expect(query).not.toMatch(/token_hash|openid|FOR\s+(UPDATE|SHARE)|INSERT|UPDATE|DELETE/i);
          expect(sql.mock.calls[0]!.slice(1)).toEqual([principal.sessionId]);
        } finally {
          sql.mockRestore();
        }
      });
      expect(await read(principal, at)).toEqual(principal);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it.each(["idle", "absolute"] as const)(
    "%s 到期差一毫秒有效、相等与之后无效且零写",
    async (kind) => {
      const { principal } = await register();
      const session = await h.prisma.userSession.findUniqueOrThrow({
        where: { id: principal.sessionId },
      });
      const boundary = kind === "idle" ? session.idleExpiresAt : session.absoluteExpiresAt;
      if (kind === "absolute")
        await h.prisma.userSession.update({
          where: { id: session.id },
          data: { idleExpiresAt: new Date(boundary.getTime() + 1) },
        });
      const before = await snapshotTables(h.prisma, TABLES);
      expect(await read(principal, new Date(boundary.getTime() - 1))).toEqual(principal);
      await invalid(read(principal, boundary));
      await invalid(read(principal, new Date(boundary.getTime() + 1)));
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it.each(["sessionId", "merchantUserId", "wechatIdentityId"] as const)(
    "伪造 %s 不构成授权",
    async (field) => {
      const { principal } = await register();
      const other = await register();
      const before = await snapshotTables(h.prisma, TABLES);
      await invalid(read({ ...principal, [field]: other.principal[field] }));
      await invalid(read({ ...principal, [field]: uuidv7() }));
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it(
    "实际身份 AppID 必须匹配，不按 principal 或调用方构造推断",
    async () => {
      const { principal } = await register();
      const before = await snapshotTables(h.prisma, TABLES);
      await invalid(read(principal, h.clock.now(), "wxotherpublictest"));
      await invalid(read(principal, h.clock.now(), ""));
      expect(await read(principal)).toEqual(principal);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it.each(["disabled", "deleted"] as const)(
    "真实 %s 账号不能以旧 principal 继续",
    async (status) => {
      const { principal } = await register();
      await h.prisma.merchantUser.update({
        where: { id: principal.merchantUserId },
        data: {
          status,
          ...(status === "deleted"
            ? {
                deletedAt: h.clock.now(),
                phoneEnc: null,
                phoneBidx: null,
                phoneMask: null,
                phoneLast4: null,
                displayName: null,
              }
            : {}),
        },
      });
      const before = await snapshotTables(h.prisma, TABLES);
      await invalid(read(principal));
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it.each(["logout", "admin", "evicted"] as const)(
    "实际 %s 吊销即拒绝，零额外写",
    async (revokeReason) => {
      const { principal } = await register();
      if (revokeReason === "logout") await h.identity.logout(principal, META);
      else
        await h.prisma.userSession.update({
          where: { id: principal.sessionId },
          data: { revokedAt: h.clock.now(), revokeReason },
        });
      const before = await snapshotTables(h.prisma, TABLES);
      await invalid(read(principal));
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it(
    "真实改绑删旧身份、吊销旧会话，新身份属于新账号",
    async () => {
      const old = await register();
      const rebound = await register({ openid: old.openid, phone: nextPhone() });
      const session = await h.prisma.userSession.findUniqueOrThrow({
        where: { id: old.principal.sessionId },
      });
      expect(session).toMatchObject({ wechatIdentityId: null, revokeReason: "identity_rebound" });
      const before = await snapshotTables(h.prisma, TABLES);
      await invalid(read(old.principal));
      expect(await read(rebound.principal)).toEqual(rebound.principal);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it(
    "真实第六次登录挤掉原会话，当前会话仍可读",
    async () => {
      const first = await register();
      let latest = first;
      for (let i = 0; i < 5; i += 1) {
        h.clock.advance(1);
        latest = await register({ phone: first.phone, openid: first.openid });
      }
      expect(
        await h.prisma.userSession.findUniqueOrThrow({ where: { id: first.principal.sessionId } }),
      ).toMatchObject({ revokeReason: "evicted" });
      const before = await snapshotTables(h.prisma, TABLES);
      await invalid(read(first.principal));
      expect(await read(latest.principal)).toEqual(latest.principal);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it.each([null, "a".repeat(64)])(
    "返回当前 consentStamp=%s；旧 stamp 不使会话失效，也不补同意",
    async (consentStamp) => {
      const { principal } = await register();
      await h.prisma.merchantUser.update({
        where: { id: principal.merchantUserId },
        data: { consentStamp },
      });
      const before = await snapshotTables(h.prisma, TABLES);
      expect(await read(principal)).toEqual({ ...principal, consentStamp });
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it(
    "无效 Date 是编程错误，在任何 SQL 前拒绝",
    async () => {
      const { principal } = await register();
      const before = await snapshotTables(h.prisma, TABLES);
      await h.tx.run(async (tx) => {
        const sql = vi.spyOn(tx, "$queryRaw");
        try {
          await expect(
            assertCurrentSession(tx, principal, new Date(NaN), TEST_APPID),
          ).rejects.toBeInstanceOf(TypeError);
          expect(sql).not.toHaveBeenCalled();
        } finally {
          sql.mockRestore();
        }
      });
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it(
    "callerTx 可见未提交指纹，外层失败后完整回滚",
    async () => {
      const { principal } = await register();
      const before = await snapshotTables(h.prisma, TABLES);
      const rollback = new Error("公开虚构回滚标记");
      await expect(
        h.tx.run(async (tx) => {
          await tx.merchantUser.update({
            where: { id: principal.merchantUserId },
            data: { consentStamp: null },
          });
          expect(await assertCurrentSession(tx, principal, h.clock.now(), TEST_APPID)).toEqual({
            ...principal,
            consentStamp: null,
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await read(principal)).toEqual(principal);
      assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
    },
    SLOW,
  );

  it(
    "两 app 连接：真实 logout 未提交可读旧快照，提交后下一语句拒绝",
    async () => {
      const { principal } = await register();
      const holderClient = await openClient(db);
      const readerClient = await openClient(db);
      const holder = h.stackOn(holderClient);
      const reader = h.stackOn(readerClient);
      const entered = latch();
      const release = latch();
      let holderPid = 0;
      const original = holder.tx.run;
      holder.tx.run = <T>(fn: (tx: Tx) => Promise<T>, options?: TxRunOptions) =>
        original(async (tx) => {
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          holderPid = row!.pid;
          const value = await fn(tx);
          await invalid(assertCurrentSession(tx, principal, h.clock.now(), TEST_APPID));
          entered.resolve();
          await bounded(release.promise);
          return value;
        }, options);
      const logout = holder.identity.logout(principal, META).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await bounded(
          Promise.race([
            entered.promise,
            logout.then(() => {
              throw new Error("退出事务未停在提交前");
            }),
          ]),
        );
        await reader.tx.run(async (tx) => {
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          expect(row!.pid).not.toBe(holderPid);
          expect(await assertCurrentSession(tx, principal, h.clock.now(), TEST_APPID)).toEqual(
            principal,
          );
        });
        release.resolve();
        expect(await bounded(logout)).toEqual({ ok: true });
        const before = await snapshotTables(h.prisma, TABLES);
        await invalid(
          reader.tx.run((tx) => assertCurrentSession(tx, principal, h.clock.now(), TEST_APPID)),
        );
        assertSnapshotsEqual(before, await snapshotTables(h.prisma, TABLES));
      } finally {
        release.resolve();
        await logout;
        holder.tx.run = original;
        await Promise.all([holderClient.$disconnect(), readerClient.$disconnect()]);
      }
    },
    SLOW,
  );
});
