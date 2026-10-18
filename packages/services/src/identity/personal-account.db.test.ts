import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunOptions } from "../kernel/index.js";
import { snapshotTables, useSeededDatabase } from "../testing/index.js";
import { buildHarness, META, nextOpenid, nextPhone, TEST_APPID } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import type { SessionPrincipal } from "./index.js";
import { openSession } from "./sessions.js";

const db = useSeededDatabase("services", { label: "personal", max: 1 });
const DAY = 86_400_000;
const TABLES = [
  "merchant_user",
  "wechat_identity",
  "user_session",
  "merchant_user_notice",
  "wx_subscribe_quota",
  "entity_member",
  "agreement_consent",
  "audit_log",
  "auth_event",
  "outbox_event",
  "status_transition",
];
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 120_000);
afterEach(() => {
  vi.restoreAllMocks();
  h.wechat.textVerdicts.length = 0;
  h.wechat.setTextCheckAvailable(true);
  h.identityRemoveMinAgeDays = 7;
});
async function user() {
  const phone = nextPhone(),
    openid = nextOpenid();
  const result = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid }),
    consents: h.consents(),
  });
  const checked = await h.identity.authenticate(result.token, { ip: META.ip });
  if (!checked.ok) throw new Error("真实登录未形成当前会话");
  return { phone, openid, result, principal: checked.principal };
}
async function another(principal: SessionPrincipal, days = 0) {
  const now = h.clock.now();
  const identity = await h.prisma.wechatIdentity.create({
    data: {
      id: uuidv7(),
      merchantUserId: principal.merchantUserId,
      appid: TEST_APPID,
      openid: nextOpenid(),
      lastLoginAt: now,
      lastActiveAt: now,
      createdAt: new Date(now.getTime() - days * DAY),
      updatedAt: now,
    },
  });
  const session = await h.tx.run((tx) =>
    openSession(tx, now, {
      merchantUserId: principal.merchantUserId,
      wechatIdentityId: identity.id,
      ip: META.ip,
      deviceInfo: "独立虚构设备",
    }),
  );
  return { identity, session };
}
function idem(
  principal: SessionPrincipal,
  scope: string,
  body: unknown,
  params = {},
  key = uuidv7(),
) {
  return {
    idem: createIdempotencyContext({
      mode: "required",
      scope,
      actor: { type: "merchant", id: principal.merchantUserId, client: "weapp", role: null },
      key,
      request: {
        method: scope === "m.me.update" ? "PATCH" : scope.endsWith("delete") ? "DELETE" : "POST",
        body,
        pathParams: params,
        storeId: null,
      },
    }),
  };
}
const state = () => snapshotTables(h.prisma, TABLES);
async function notice(principal: SessionPrincipal) {
  const now = h.clock.now();
  return h.prisma.merchantUserNotice.create({
    data: {
      id: uuidv7(),
      merchantUserId: principal.merchantUserId,
      kind: "new_wechat_bound",
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}

describe("个人账号：真实同事务与个人范围", { timeout: 120_000 }, () => {
  it("修改称呼仅写账号，当前openid事务外检查；Provider挂后成功同键仍重放原值", async () => {
    const { principal, openid } = await user(),
      key = uuidv7(),
      input = { displayName: `  ${"😀".repeat(20)}  ` };
    const member = await h.tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: principal.merchantUserId, client: "weapp" },
      }),
    );
    await h.prisma.entityMember.update({
      where: { id: member.memberId },
      data: { displayName: "独立成员称呼" },
    });
    const fixed = await snapshotTables(
        h.prisma,
        TABLES.filter((t) => t !== "merchant_user"),
      ),
      calls = h.wechat.callsOf("checkText").length;
    const result = await h.identity.updateMe(
      principal,
      META,
      input,
      idem(principal, "m.me.update", input, {}, key),
    );
    expect(result.displayName).toBe("😀".repeat(20));
    expect(h.wechat.callsOf("checkText").slice(calls)).toMatchObject([
      { input: { openid, scene: "profile", content: "😀".repeat(20) } },
    ]);
    expect(
      await snapshotTables(
        h.prisma,
        TABLES.filter((t) => t !== "merchant_user"),
      ),
    ).toEqual(fixed);
    const stored = await h.prisma.merchantUser.findUniqueOrThrow({
      where: { id: principal.merchantUserId },
    });
    h.clock.advance(1_000);
    h.wechat.setTextCheckAvailable(false);
    expect(
      await h.identity.updateMe(
        principal,
        META,
        input,
        idem(principal, "m.me.update", input, {}, key),
      ),
    ).toEqual(result);
    expect(h.wechat.callsOf("checkText").length).toBe(calls + 1);
    expect(
      await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: principal.merchantUserId } }),
    ).toEqual(stored);
  });

  it.each(["block", "unavailable"] as const)(
    "文本安全 %s 拒绝，业务行、会话和历史全部不动",
    async (mode) => {
      const { principal } = await user(),
        before = await state();
      if (mode === "block") h.wechat.textVerdicts.push("block");
      else h.wechat.setTextCheckAvailable(false);
      await expect(
        h.identity.updateMe(
          principal,
          META,
          { displayName: "等待检测" },
          idem(principal, "m.me.update", { displayName: "等待检测" }),
        ),
      ).rejects.toMatchObject(
        mode === "block"
          ? { error: "CONTENT_REJECTED", details: { fields: ["displayName"] } }
          : { error: "PROVIDER_UNAVAILABLE" },
      );
      expect(await state()).toEqual(before);
    },
  );

  it("空白和21码点称呼拒绝，不调用Provider或写库", async () => {
    const { principal } = await user(),
      before = await state(),
      calls = h.wechat.callsOf("checkText").length;
    for (const displayName of ["   ", "😀".repeat(21)])
      await expect(h.identity.updateMe(principal, META, { displayName })).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
      });
    expect(h.wechat.callsOf("checkText").length).toBe(calls);
    expect(await state()).toEqual(before);
  });

  it("成功收据重放前仍重查当前会话，失效会话不能取回修改结果", async () => {
    const { principal } = await user(),
      input = { displayName: "原成功称呼" },
      key = uuidv7();
    await h.identity.updateMe(
      principal,
      META,
      input,
      idem(principal, "m.me.update", input, {}, key),
    );
    await h.prisma.userSession.update({
      where: { id: principal.sessionId },
      data: { revokedAt: h.clock.now(), revokeReason: "admin" },
    });
    const before = await state(),
      calls = h.wechat.callsOf("checkText").length;
    await expect(
      h.identity.updateMe(principal, META, input, idem(principal, "m.me.update", input, {}, key)),
    ).rejects.toMatchObject({ error: "SESSION_INVALID" });
    expect(h.wechat.callsOf("checkText").length).toBe(calls);
    expect(await state()).toEqual(before);
  });

  it("提示关闭同键/新键均返回首次时间，其他提示及审计事件保持", async () => {
    const { principal } = await user(),
      n = await notice(principal),
      untouched = await notice(principal),
      key = uuidv7(),
      input = { userNoticeId: n.id };
    const history = await snapshotTables(h.prisma, [
      "audit_log",
      "auth_event",
      "outbox_event",
      "status_transition",
    ]);
    const first = await h.identity.acknowledgeUserNotice(
      principal,
      META,
      input,
      idem(principal, "m.me.userNotice.acknowledge", null, input, key),
    );
    h.clock.advance(1_000);
    for (const reuse of [key, uuidv7()])
      expect(
        await h.identity.acknowledgeUserNotice(
          principal,
          META,
          input,
          idem(principal, "m.me.userNotice.acknowledge", null, input, reuse),
        ),
      ).toEqual(first);
    expect(
      await h.prisma.merchantUserNotice.findUniqueOrThrow({ where: { id: untouched.id } }),
    ).toEqual(untouched);
    expect(
      await snapshotTables(h.prisma, [
        "audit_log",
        "auth_event",
        "outbox_event",
        "status_transition",
      ]),
    ).toEqual(history);
  });

  it("提示不存在/属于其他人一律404且零写", async () => {
    const own = await user(),
      foreign = await notice((await user()).principal),
      before = await state();
    for (const userNoticeId of [uuidv7(), foreign.id])
      await expect(
        h.identity.acknowledgeUserNotice(own.principal, META, { userNoticeId }),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await state()).toEqual(before);
  });

  it("身份列表当前首屏、相同时间id稳定分页、最近设备最小投影，GET零写", async () => {
    const { principal } = await user(),
      a = await another(principal),
      b = await another(principal);
    await h.prisma.wechatIdentity.update({
      where: { id: principal.wechatIdentityId },
      data: { lastLoginAt: new Date(h.clock.now().getTime() - DAY) },
    });
    const before = await state(),
      first = await h.identity.listWechatIdentities(principal, { limit: 1 });
    expect(first.items[0]).toMatchObject({
      wechatIdentityId: principal.wechatIdentityId,
      isCurrent: true,
      actions: ["delete"],
    });
    const second = await h.identity.listWechatIdentities(principal, {
      limit: 1,
      cursor: first.nextCursor!,
    });
    const third = await h.identity.listWechatIdentities(principal, {
      limit: 1,
      cursor: second.nextCursor!,
    });
    expect([second.items[0]!.wechatIdentityId, third.items[0]!.wechatIdentityId]).toEqual(
      [a.identity.id, b.identity.id].sort().reverse(),
    );
    expect(second.items[0]).toMatchObject({ deviceSummary: "独立虚构设备", actions: [] });
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    expect(Object.keys(second.items[0]!).sort()).toEqual([
      "actions",
      "boundAt",
      "deviceSummary",
      "isCurrent",
      "lastLoginAt",
      "wechatIdentityId",
    ]);
    expect(await state()).toEqual(before);
  });

  it("游标绑定本人/当前身份，非法游标与分页界限拒绝且零写", async () => {
    const own = await user(),
      foreign = await user();
    await another(own.principal);
    const page = await h.identity.listWechatIdentities(own.principal, { limit: 1 }),
      before = await state();
    await expect(
      h.identity.listWechatIdentities(foreign.principal, { cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    for (const input of [{ cursor: "bad" }, { limit: 0 }, { limit: 51 }])
      await expect(h.identity.listWechatIdentities(own.principal, input)).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
      });
    expect(await state()).toEqual(before);
  });

  it("删其他身份按当前绑定年龄，恰好七天可删并原收据重放，FK额度和全部会话原子清理", async () => {
    const { principal } = await user(),
      target = await another(principal),
      input = { wechatIdentityId: target.identity.id },
      key = uuidv7(),
      now = h.clock.now();
    await h.tx.run((tx) =>
      openSession(tx, now, {
        merchantUserId: principal.merchantUserId,
        wechatIdentityId: target.identity.id,
        ip: META.ip,
        deviceInfo: "第二会话",
      }),
    );
    const slot = await h.prisma.wxTemplateSlot.findFirstOrThrow();
    await h.prisma.wxSubscribeQuota.create({
      data: {
        wechatIdentityId: target.identity.id,
        merchantUserId: principal.merchantUserId,
        wxTemplateSlotKey: slot.slotKey,
        estRemaining: 2,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.wechatIdentity.update({
      where: { id: principal.wechatIdentityId },
      data: { createdAt: new Date(now.getTime() - 7 * DAY + 1) },
    });
    const before = await state();
    await expect(
      h.identity.removeWechatIdentity(
        principal,
        META,
        input,
        idem(principal, "m.me.wechatIdentity.delete", null, input, key),
      ),
    ).rejects.toMatchObject({
      error: "IDENTITY_TOO_NEW",
      details: { removableAt: new Date(now.getTime() + 1).toISOString() },
    });
    expect(await state()).toEqual(before);
    h.clock.advance(1);
    const result = await h.identity.removeWechatIdentity(
      principal,
      META,
      input,
      idem(principal, "m.me.wechatIdentity.delete", null, input, key),
    );
    expect(result).toEqual({
      wechatIdentityId: target.identity.id,
      revokedSessionCount: 2,
      isCurrentSessionRevoked: false,
    });
    expect(
      await h.prisma.wxSubscribeQuota.count({ where: { wechatIdentityId: target.identity.id } }),
    ).toBe(0);
    const sessions = await h.prisma.userSession.findMany({
      where: { merchantUserId: principal.merchantUserId, revokeReason: "identity_removed" },
    });
    expect(sessions).toHaveLength(2);
    for (const session of sessions) expect(session.wechatIdentityId).toBeNull();
    expect(
      await h.identity.removeWechatIdentity(
        principal,
        META,
        input,
        idem(principal, "m.me.wechatIdentity.delete", null, input, key),
      ),
    ).toEqual(result);
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: target.identity.id, action: "identity.wechat_identity.remove" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.authEvent.count({
        where: { subjectId: principal.merchantUserId, event: "identity_removed" },
      }),
    ).toBe(1);
    expect(await h.identity.authenticate(target.session.token, { ip: null })).toMatchObject({
      ok: false,
    });
  });

  it("移除外国/不存在身份均404，不改目标或任何会话", async () => {
    const own = await user(),
      foreign = await user(),
      before = await state();
    for (const wechatIdentityId of [foreign.principal.wechatIdentityId, uuidv7()])
      await expect(
        h.identity.removeWechatIdentity(own.principal, META, { wechatIdentityId }),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await state()).toEqual(before);
  });

  it("当前且最后一个身份总能移除，当前会话吊销后重放先被鉴权拒绝", async () => {
    const { principal, result } = await user(),
      input = { wechatIdentityId: principal.wechatIdentityId },
      key = uuidv7();
    expect(
      await h.identity.removeWechatIdentity(
        principal,
        META,
        input,
        idem(principal, "m.me.wechatIdentity.delete", null, input, key),
      ),
    ).toEqual({
      wechatIdentityId: input.wechatIdentityId,
      revokedSessionCount: 1,
      isCurrentSessionRevoked: true,
    });
    expect(
      await h.prisma.wechatIdentity.count({ where: { merchantUserId: principal.merchantUserId } }),
    ).toBe(0);
    expect(await h.identity.authenticate(result.token, { ip: null })).toMatchObject({ ok: false });
    await expect(
      h.identity.removeWechatIdentity(
        principal,
        META,
        input,
        idem(principal, "m.me.wechatIdentity.delete", null, input, key),
      ),
    ).rejects.toMatchObject({ error: "SESSION_INVALID" });
  });

  it("删除后事务故障：身份、FK额度、会话、审计/auth与幂等整体回滚", async () => {
    const { principal } = await user(),
      target = await another(principal),
      input = { wechatIdentityId: target.identity.id };
    h.identityRemoveMinAgeDays = 0;
    const slot = await h.prisma.wxTemplateSlot.findFirstOrThrow(),
      now = h.clock.now();
    await h.prisma.wxSubscribeQuota.create({
      data: {
        wechatIdentityId: target.identity.id,
        merchantUserId: principal.merchantUserId,
        wxTemplateSlotKey: slot.slotKey,
        estRemaining: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    const rollbackTables = [...TABLES, "idempotency_record"];
    const before = await snapshotTables(h.prisma, rollbackTables),
      failure = new Error("真实删除完成后外层事务失败"),
      real = h.tx.run;
    vi.spyOn(h.tx, "run").mockImplementation(
      <T>(fn: (tx: Tx) => Promise<T>, options?: TxRunOptions): Promise<T> =>
        real(async (tx) => {
          const result = await fn(tx);
          if (options?.idem) throw failure;
          return result;
        }, options),
    );
    await expect(
      h.identity.removeWechatIdentity(
        principal,
        META,
        input,
        idem(principal, "m.me.wechatIdentity.delete", null, input),
      ),
    ).rejects.toBe(failure);
    expect(await snapshotTables(h.prisma, rollbackTables)).toEqual(before);
  });
});
