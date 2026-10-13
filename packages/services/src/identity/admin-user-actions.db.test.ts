import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildStaffContext, isStaffRoleKey, normalizeRoleConfig } from "../authz/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import {
  assembleForTest,
  signInAsStaff,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { buildHarness, META, nextOpenid, nextPhone } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { adminUserAction } from "./admin-user-actions.js";
import type { AdminUserAction, AdminUserActionInput } from "./admin-user-actions.js";

const db = useSeededDatabase("services", { label: "adminuser", max: 1 });
const assembly = assembleForTest({ entry: "api" });
let h: Harness, events: ReturnType<typeof createEvents>, flow: ReturnType<typeof createFlow>;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
  events = createEvents({ assembly, clock: h.clock, tx: h.tx });
  flow = createFlow({ assembly, clock: h.clock, events });
}, 120_000);
afterEach(() => vi.restoreAllMocks());
const TABLES = [
  "merchant_user",
  "wechat_identity",
  "user_session",
  "portal_session",
  "entity_member",
  "store_member",
  "status_transition",
  "outbox_event",
  "audit_log",
  "idempotency_record",
];
async function actor(roleKey: "super_admin" | "cs" = "super_admin", isLead = false) {
  const signed = await signInAsStaff(h.prisma, { roleKey, isLead, now: h.clock.now() });
  const role = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } });
  const row = signed.staff;
  if (!isStaffRoleKey(row.staffRoleKey)) throw new Error("测试角色未登记");
  const staff = buildStaffContext({
    staff: {
      id: row.id,
      roleKey: row.staffRoleKey,
      isLead: row.isLead,
      staffGroupId: row.staffGroupId,
    },
    role: normalizeRoleConfig(row.staffRoleKey, role),
    groupStaffIds: [row.id],
    stepUpAt: h.clock.now(),
  });
  const ctx = createIdentityContext({
    actor: { type: "staff", id: row.id, client: "admin" },
    ...META,
  });
  const meta = { ...META, sessionId: signed.sessionId, authMethod: "password+totp" as const };
  return { signed, staff, ctx, meta };
}
async function user(owner = true) {
  const phone = nextPhone(),
    openid = nextOpenid();
  const login = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid }),
    consents: h.consents(),
  });
  const auth = await h.identity.authenticate(login.token, { ip: META.ip });
  if (!auth.ok) throw new Error("真实登录没有当前会话");
  const id = auth.principal.merchantUserId;
  const entity = await h.make.entity({ createdByUserId: id }),
    store = await h.make.store({ entityId: entity.id });
  const member = owner
    ? await h.make.entityMember({ entityId: entity.id, merchantUserId: id, role: "owner" })
    : null;
  const device = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid: nextOpenid() }),
    consents: h.consents(),
  });
  const row = await h.prisma.merchantUser.findUniqueOrThrow({ where: { id } });
  return { id, phone, openid, login, device, entity, store, member, row };
}
async function grant(
  who: Awaited<ReturnType<typeof user>>,
  extra: { expired?: boolean; revoked?: boolean; approver?: string } = {},
) {
  const now = h.clock.now(),
    id = uuidv7();
  return h.prisma.portalSession.create({
    data: {
      id,
      tokenHash: createHash("sha256").update(id).digest(),
      portalTicketId: uuidv7(),
      approvedByUserId: extra.approver ?? who.id,
      entityId: who.entity.id,
      storeId: who.store.id,
      grantScope: "store",
      expiresAt: new Date(now.getTime() + (extra.expired ? -3600000 : 3600000)),
      ip: META.ip!,
      userAgent: META.userAgent,
      createdAt: now,
      updatedAt: now,
      ...(extra.revoked ? { revokedAt: now, revokeReason: "portal_logout" } : {}),
    },
  });
}
function options(
  who: Awaited<ReturnType<typeof actor>>,
  op: AdminUserAction,
  input: AdminUserActionInput,
  key = uuidv7(),
) {
  const { merchantUserId, ...body } = input;
  return {
    meta: who.meta,
    idem: createIdempotencyContext({
      mode: "required",
      scope: `admin.merchantUser.${op}`,
      key,
      actor: who.ctx.actor,
      request: { method: "POST", pathParams: { merchantUserId }, body, storeId: null },
    }),
  };
}
const inputOf = (who: Awaited<ReturnType<typeof user>>): AdminUserActionInput => ({
  merchantUserId: who.id,
  reasonText: "真实账号安全处置",
  confirm: { phoneMask: who.row.phoneMask! },
});
const run = (
  who: Awaited<ReturnType<typeof actor>>,
  op: AdminUserAction,
  input: AdminUserActionInput,
  key = uuidv7(),
) =>
  adminUserAction(
    { tx: h.tx, clock: h.clock, flow },
    who.ctx,
    who.staff,
    op,
    input,
    options(who, op, input, key),
  );

describe("后台账号三动作真实数据库", { timeout: 120_000 }, () => {
  it("disable真实老板：全部小程序和本人授权portal含过期未吊销，旧吊销/他人授权和成员保持", async () => {
    const staff = await actor("cs", true),
      who = await user(),
      input = inputOf(who);
    const a = await grant(who),
      expired = await grant(who, { expired: true }),
      old = await grant(who, { revoked: true }),
      outsider = await h.make.merchantUser(),
      other = await grant(who, { approver: outsider.id });
    const members = await snapshotTables(h.prisma, ["entity_member", "store_member"]);
    expect(await run(staff, "disable", input)).toEqual({
      merchantUserId: who.id,
      status: "disabled",
      phoneMask: who.row.phoneMask,
      revokedSessionCount: 2,
      revokedPortalSessionCount: 2,
      activeOwnerEntityIds: [who.entity.id],
    });
    expect(
      await h.prisma.userSession.findMany({ where: { merchantUserId: who.id } }),
    ).toMatchObject([{ revokeReason: "admin" }, { revokeReason: "admin" }]);
    for (const row of [a, expired])
      expect(
        await h.prisma.portalSession.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ revokeReason: "account_action", revokedAt: h.clock.now() });
    for (const row of [old, other])
      expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual(
        row,
      );
    expect(await snapshotTables(h.prisma, ["entity_member", "store_member"])).toEqual(members);
    expect(
      await h.prisma.statusTransition.findFirstOrThrow({
        where: { subjectId: who.id, event: "merchant_user.disable" },
      }),
    ).toMatchObject({ fromState: "active", toState: "disabled", note: input.reasonText });
    expect(
      await h.prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: who.id, eventType: "merchant_user.disabled" },
      }),
    ).toMatchObject({
      actorId: staff.signed.staff.id,
      payload: {
        v: 1,
        merchantUserId: who.id,
        fromState: "active",
        toState: "disabled",
        transition: "merchant_user.disable",
      },
    });
    expect(
      await h.prisma.auditLog.findFirstOrThrow({
        where: { targetId: who.id, action: "identity.merchant_user.disable" },
      }),
    ).toMatchObject({
      stream: "ops",
      category: "account_security",
      sessionId: staff.signed.sessionId,
      authMethod: "password+totp",
      reasonText: input.reasonText,
    });
    expect(await h.identity.authenticate(who.login.token, { ip: META.ip })).toMatchObject({
      ok: false,
    });
  });
  it("enable不复活会话；原键正常重放不二次审计，scope撤离404，失效员工会话仍401", async () => {
    const staff = await actor("cs", true),
      who = await user(),
      input = inputOf(who),
      key = uuidv7();
    const role = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: "cs" } });
    try {
      await h.prisma.staffRole.update({ where: { key: "cs" }, data: { dataScope: "own" } });
      await h.prisma.store.update({
        where: { id: who.store.id },
        data: { deliveryManagerId: staff.signed.staff.id },
      });
      await run(staff, "disable", input);
      const result = await run(staff, "enable", input, key);
      expect(result).toMatchObject({
        status: "active",
        revokedSessionCount: 0,
        revokedPortalSessionCount: 0,
      });
      expect(await run(staff, "enable", input, key)).toEqual(result);
      expect(
        await h.prisma.auditLog.count({
          where: { targetId: who.id, action: "identity.merchant_user.enable" },
        }),
      ).toBe(1);
      expect(await h.identity.authenticate(who.login.token, { ip: META.ip })).toMatchObject({
        ok: false,
      });
      const login = await h.identity.phoneLogin(META, {
        ...h.codes({ phone: who.phone, openid: who.openid }),
        consents: h.consents(),
      });
      expect(await h.identity.authenticate(login.token, { ip: META.ip })).toMatchObject({
        ok: true,
      });
      await expect(run(staff, "enable", input)).rejects.toMatchObject({
        error: "STATE_NOT_ALLOWED",
      });
      const outsider = await h.make.staff();
      await h.prisma.store.update({
        where: { id: who.store.id },
        data: { deliveryManagerId: outsider.id },
      });
      await expect(run(staff, "enable", input, key)).rejects.toMatchObject({ error: "NOT_FOUND" });
      await h.prisma.staffSession.update({
        where: { id: staff.signed.sessionId },
        data: { revokedAt: h.clock.now(), revokeReason: "admin" },
      });
      await expect(run(staff, "enable", input, key)).rejects.toMatchObject({
        error: "SESSION_INVALID",
      });
    } finally {
      await h.prisma.staffRole.update({
        where: { key: "cs" },
        data: { dataScope: role.dataScope },
      });
    }
  });
  it("forceLogout客服可用且无需stepUp：全身份静默关闭，无迁移事件，换键再次吊销为零，手机号登录恢复当前身份", async () => {
    const staff = await actor("cs"),
      who = await user(),
      input = inputOf(who),
      key = uuidv7();
    await h.prisma.staffSession.update({
      where: { id: staff.signed.sessionId },
      data: { stepupAt: new Date(h.clock.now().getTime() - 660000) },
    });
    await grant(who);
    const fixed = await snapshotTables(h.prisma, [
      "status_transition",
      "outbox_event",
      "entity_member",
    ]);
    const result = await run(staff, "forceLogout", input, key);
    expect(result).toMatchObject({
      status: "active",
      revokedSessionCount: 2,
      revokedPortalSessionCount: 1,
    });
    expect(await run(staff, "forceLogout", input, key)).toEqual(result);
    expect(await run(staff, "forceLogout", input)).toMatchObject({
      revokedSessionCount: 0,
      revokedPortalSessionCount: 0,
    });
    expect(
      await h.prisma.wechatIdentity.findMany({ where: { merchantUserId: who.id } }),
    ).toMatchObject([{ silentLoginEnabled: false }, { silentLoginEnabled: false }]);
    expect(
      await h.identity.silentLogin(META, {
        loginCode: h.codes({ phone: who.phone, openid: who.openid }).loginCode,
      }),
    ).toEqual({ needPhone: true });
    expect(
      await snapshotTables(h.prisma, ["status_transition", "outbox_event", "entity_member"]),
    ).toEqual(fixed);
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: who.id, action: "identity.merchant_user.force_logout" },
      }),
    ).toBe(2);
    await h.identity.phoneLogin(META, {
      ...h.codes({ phone: who.phone, openid: who.openid }),
      consents: h.consents(),
    });
    expect(
      await h.prisma.wechatIdentity.findFirstOrThrow({
        where: { merchantUserId: who.id, openid: who.openid },
      }),
    ).toMatchObject({ silentLoginEnabled: true });
  });
  it("真实权限/stepUp/确认/终态拒绝且零业务写；伪造flow args无法绕过守卫", async () => {
    const admin = await actor(),
      cs = await actor("cs"),
      lead = await actor("cs", true),
      who = await user(),
      input = inputOf(who);
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(run(cs, "disable", input)).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await h.prisma.staffSession.update({
      where: { id: lead.signed.sessionId },
      data: { stepupAt: new Date(h.clock.now().getTime() - 660000) },
    });
    await expect(run(lead, "disable", input)).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
    await expect(
      run(admin, "disable", { ...input, confirm: { phoneMask: "错误回显" } }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    await expect(run(admin, "disable", { ...input, reasonText: " " })).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
    });
    await expect(
      h.tx.run((tx) =>
        flow.transition(tx, admin.ctx, {
          machine: "merchant_user",
          stateField: "status",
          id: who.id,
          event: "merchant_user.disable",
          ref: "02:126",
          args: { authorized: true, confirm: input.confirm, staff: admin.staff },
          emit: { type: "merchant_user.disabled", payload: { v: 1, merchantUserId: who.id } },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
    const deleted = await h.make.merchantUser({
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
      deletedAt: h.clock.now(),
    });
    await expect(
      run(admin, "forceLogout", { ...input, merchantUserId: deleted.id }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    const after = await snapshotTables(h.prisma, TABLES);
    expect(after["user_session"]).toEqual(before["user_session"]);
    for (const table of TABLES.filter((table) => table !== "merchant_user"))
      expect(after[table]).toEqual(before[table]);
  });
  it("锁后读取最新role/scope：旧all上下文不能越过新own；仅历史成员按无成员处理，all仍可处置", async () => {
    const lead = await actor("cs", true),
      admin = await actor(),
      who = await user(),
      plain = await user(false),
      input = inputOf(who);
    const original = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: "cs" } });
    try {
      await h.prisma.staffRole.update({ where: { key: "cs" }, data: { dataScope: "own" } });
      await expect(run(lead, "forceLogout", input)).rejects.toMatchObject({ error: "NOT_FOUND" });
      await h.prisma.store.update({
        where: { id: who.store.id },
        data: { deliveryManagerId: lead.signed.staff.id },
      });
      expect(await run(lead, "forceLogout", input)).toMatchObject({
        status: "active",
        revokedSessionCount: 2,
      });
      await h.make.entityMember({
        entityId: who.entity.id,
        merchantUserId: plain.id,
        status: "removed",
        removedAt: h.clock.now(),
        removeReason: "self",
        removeActorType: "merchant",
        removeActorId: plain.id,
        removeClient: "weapp",
      });
      await expect(run(lead, "forceLogout", inputOf(plain))).rejects.toMatchObject({
        error: "NOT_FOUND",
      });
      expect(await run(admin, "forceLogout", inputOf(plain))).toMatchObject({
        activeOwnerEntityIds: [],
      });
      await h.make.entityMember({
        entityId: who.entity.id,
        merchantUserId: plain.id,
        role: "clerk",
      });
      expect(await run(lead, "forceLogout", inputOf(plain))).toMatchObject({
        activeOwnerEntityIds: [],
        revokedSessionCount: 0,
      });
      await h.prisma.staffRole.update({
        where: { key: "cs" },
        data: {
          actions: {
            ...(original.actions as Record<string, string>),
            "merchant.user.force_logout": "off",
          },
        },
      });
      await expect(run(lead, "forceLogout", input)).rejects.toMatchObject({
        error: "PERMISSION_DENIED",
      });
    } finally {
      await h.prisma.staffRole.update({
        where: { key: "cs" },
        data: { dataScope: original.dataScope, actions: original.actions! },
      });
    }
  });
  it("真实出站写后异常整笔回滚账号/历史/审计/会话与幂等，原依赖异常不吞", async () => {
    const staff = await actor(),
      who = await user(),
      input = inputOf(who);
    await grant(who);
    const before = await snapshotTables(h.prisma, TABLES),
      real = events.emit;
    const failure = new Error("lyxtest admin action rollback");
    vi.spyOn(events, "emit").mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[2].type === "merchant_user.disabled") throw failure;
      return result;
    });
    await expect(run(staff, "disable", input)).rejects.toBe(failure);
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });
});
