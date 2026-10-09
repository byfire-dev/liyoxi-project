import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  StaffCreateBodySchema,
  StaffUpdateBodySchema,
  StaffPoolMembershipReplaceBodySchema,
  StaffSessionListQuerySchema,
} from "@liyoxi/contract";
import {
  fullStaffWorld,
  useSeededDatabase,
  signInAsStaff,
  sampleStaffContext,
} from "../testing/index.js";
import { createIdentityContext } from "../kernel/index.js";
import { issueActivationCode } from "./activation.js";
import type { FullStaffWorld } from "../testing/index.js";
import { SLOW, nextPhone } from "./__fixtures__/staff.js";
const db = useSeededDatabase("services");
const superDb = useSeededDatabase("services", { label: "staffsupers" });
let w: FullStaffWorld;
beforeAll(async () => {
  w = await fullStaffWorld(await db.prisma());
}, SLOW);
afterAll(() => w?.scope.close());

describe("员工全量管理真实事务", { timeout: SLOW }, () => {
  it("启用发新8字符码、保留TOTP、清失败桶，旧码失效；已启用拒绝", async () => {
    const row = await w.person("editor");
    await w.prisma.staff.update({
      where: { id: row.id },
      data: { status: "pending", failTrusted: 3, failUntrusted: 4 },
    });
    await expect(
      w.tx.run((tx) =>
        w.flow.transition(tx, w.actor, {
          machine: "staff",
          stateField: "status",
          id: row.id,
          event: "staff.enable",
          audit: {
            stream: "ops",
            category: "staff_authz",
            action: "sys.staff.enable",
            summary: "无业务校验的启用",
            target: { type: "staff", id: row.id },
          },
          emit: { type: "staff.enabled", payload: { v: 1, staffId: row.id } },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
    expect((await w.prisma.staff.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "pending",
    );
    expect(await w.prisma.statusTransition.count({ where: { subjectId: row.id } })).toBe(0);
    const old = await w.tx.run((t) =>
      issueActivationCode(t, {
        staffId: row.id,
        purpose: "activate",
        delivery: "manual",
        now: w.clock.now(),
        createdByStaffId: w.operator.id,
      }),
    );
    const result = await w.service.enable(w.ctx, w.actor, row.id, { activationDelivery: "manual" });
    expect(result.activation?.activationCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(result.staff).toMatchObject({
      status: "active",
      isActivated: false,
      security: { failTrusted: 0, failUntrusted: 0 },
    });
    expect(
      (await w.prisma.staffActivation.findUniqueOrThrow({ where: { id: old.id } })).revokedAt,
    ).not.toBeNull();
    expect(
      await w.prisma.statusTransition.count({
        where: { subjectId: row.id, event: "staff.enable" },
      }),
    ).toBe(1);
    await expect(
      w.service.enable(w.ctx, w.actor, row.id, { activationDelivery: "manual" }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });
  it("真实发送回调在提交后拿已持久激活行；失败自动手动回退，不改变8字符协议", async () => {
    const calls: string[] = [];
    w.deps.sendActivation = async (input) => {
      const actual = await w.prisma.staffActivation.findUniqueOrThrow({
        where: { id: input.activationId },
      });
      expect(actual.delivery).toBe("manual");
      expect(input.code).toMatch(/^[A-Z0-9]{8}$/);
      calls.push(input.activationId);
      return { status: "failed" };
    };
    const result = await w.service.create(
      w.ctx,
      w.actor,
      StaffCreateBodySchema.parse({
        name: "短信回退",
        phone: nextPhone(),
        roleKey: "editor",
        activateNow: true,
        activationDelivery: "sms",
      }),
    );
    expect(calls).toHaveLength(1);
    expect(result.activation).toMatchObject({ delivery: "manual", replayed: false });
    expect(result.activation?.activationCode).toMatch(/^[A-Z0-9]{8}$/);
    w.deps.sendActivation = async () => ({ status: "sent" });
    const sent = await w.service.reissueActivationCode(w.ctx, w.actor, result.staff.staffId, {
      activationDelivery: "sms",
    });
    expect(sent).toMatchObject({ delivery: "sms", activationCode: null });
    expect((await w.service.get(w.ctx, result.staff.staffId)).pendingActivation?.delivery).toBe(
      "sms",
    );
    w.deps.sendActivation = async () => ({ status: "failed" });
  });
  it("安全重置工号必须相符，本人拒绝；密码与MFA重置真实撤会话/旧码", async () => {
    const signed = await signInAsStaff(w.prisma, { roleKey: "editor", now: w.clock.now() });
    await expect(
      w.service.resetPassword(w.ctx, w.actor, signed.staff.id, {
        confirm: { staffNo: 999999 },
        activationDelivery: "manual",
      }),
    ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
    await expect(
      w.service.resetMfa(w.ctx, w.actor, w.operator.id, {
        confirm: { staffNo: w.operator.staffNo },
        activationDelivery: "manual",
      }),
    ).rejects.toMatchObject({ error: "SELF_OPERATION_FORBIDDEN" });
    const result = await w.service.resetPassword(w.ctx, w.actor, signed.staff.id, {
      confirm: { staffNo: signed.staff.staffNo },
      activationDelivery: "manual",
    });
    expect(result.activation?.purpose).toBe("reset_password");
    expect(
      (await w.prisma.staffSession.findUniqueOrThrow({ where: { id: signed.sessionId } }))
        .revokeReason,
    ).toBe("password_reset");
    const reset = await w.service.resetMfa(w.ctx, w.actor, signed.staff.id, {
      confirm: { staffNo: signed.staff.staffNo },
      activationDelivery: "manual",
    });
    expect(reset.activation?.purpose).toBe("activate");
    const row = await w.prisma.staff.findUniqueOrThrow({ where: { id: signed.staff.id } });
    expect(row).toMatchObject({
      passwordHash: null,
      totpSecretEnc: null,
      totpEnrolledAt: null,
      totpPendingSecretEnc: null,
      totpPendingAt: null,
      totpLastStep: null,
      recoveryCodes: [],
    });
  });
  it("编辑真实CAS、分组角色/主管确认，改角色清旧池；身份电话不可改", async () => {
    const row = await w.person("editor");
    await w.service.replacePools(
      w.ctx,
      w.actor,
      row.id,
      StaffPoolMembershipReplaceBodySchema.parse({
        memberships: [{ pool: "editor" }],
        lockVersion: row.lockVersion,
      }),
    );
    const before = await w.prisma.staff.findUniqueOrThrow({ where: { id: row.id } });
    await expect(
      w.service.update(
        w.ctx,
        w.actor,
        row.id,
        StaffUpdateBodySchema.parse({ name: "新名字", lockVersion: row.lockVersion }),
      ),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
    const result = await w.service.update(
      w.ctx,
      w.actor,
      row.id,
      StaffUpdateBodySchema.parse({
        roleKey: "publisher",
        ackNoLead: true,
        lockVersion: before.lockVersion,
      }),
    );
    expect(result.roleKey).toBe("publisher");
    expect(result.poolMemberships).toEqual([]);
    const after = await w.prisma.staff.findUniqueOrThrow({ where: { id: row.id } });
    expect(Buffer.from(after.phoneBidx)).toEqual(Buffer.from(row.phoneBidx));
    expect(after.staffNo).toBe(row.staffNo);
  });
  it("真实主管移除需要ack；最后超级管理员与自禁用不允许", async () => {
    const row = await w.person("content_ops");
    await expect(
      w.service.update(
        w.ctx,
        w.actor,
        row.id,
        StaffUpdateBodySchema.parse({ isLead: false, lockVersion: row.lockVersion }),
      ),
    ).rejects.toMatchObject({ error: "LEAD_REMOVAL_ACK_REQUIRED" });
    await expect(
      w.service.disable(w.ctx, w.actor, w.operator.id, {
        reason: "resigned",
        confirm: { staffNo: w.operator.staffNo, openWorkCount: 0 },
      }),
    ).rejects.toMatchObject({ error: "CANNOT_DISABLE_SELF" });
    await w.service.update(
      w.ctx,
      w.actor,
      row.id,
      StaffUpdateBodySchema.parse({ isLead: false, ackNoLead: true, lockVersion: row.lockVersion }),
    );
    const isolated = await fullStaffWorld(await superDb.prisma());
    try {
      const other = await isolated.person("super_admin");
      const otherCtx = await sampleStaffContext(isolated.prisma, other.id, {
        stepUpAt: isolated.clock.now(),
      });
      const otherActor = createIdentityContext({
        actor: { type: "staff", id: other.id, client: "admin" },
      });
      const results = await Promise.allSettled([
        isolated.service.disable(isolated.ctx, isolated.actor, other.id, {
          reason: "resigned",
          confirm: { staffNo: other.staffNo, openWorkCount: 0 },
        }),
        isolated.service.disable(otherCtx, otherActor, isolated.operator.id, {
          reason: "resigned",
          confirm: { staffNo: isolated.operator.staffNo, openWorkCount: 0 },
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toMatchObject([
        { reason: { error: "LAST_SUPER_ADMIN" } },
      ]);
      expect(
        await isolated.prisma.staff.count({
          where: { staffRoleKey: "super_admin", status: "active" },
        }),
      ).toBe(1);
      expect(
        await isolated.prisma.statusTransition.count({ where: { event: "staff.disable" } }),
      ).toBe(1);
      expect(await isolated.prisma.auditLog.count({ where: { action: "sys.staff.disable" } })).toBe(
        1,
      );
    } finally {
      await isolated.scope.close();
    }
  });
  it("企微邀请同TX写真实三表、无外呼；接管清旧绑定，禁用账号拒绝", async () => {
    const row = await w.person("editor"),
      other = await w.person("editor");
    const result = await w.service.inviteWecom(w.ctx, w.actor, row.id);
    expect(result.status).toBe("invited");
    const notification = await w.prisma.notification.findFirstOrThrow({
      where: { staffId: row.id, notifySceneKey: "s.wecom_invite" },
    });
    expect(await w.prisma.staffMessage.count({ where: { notificationId: notification.id } })).toBe(
      1,
    );
    expect(
      await w.prisma.notificationDelivery.findMany({ where: { notificationId: notification.id } }),
    ).toMatchObject([{ channel: "inbox", status: "sent" }]);
    await w.service.bindWecom(w.ctx, w.actor, other.id, {
      wecomUserid: "lyxtest_member",
      takeOver: false,
    });
    await expect(
      w.service.bindWecom(w.ctx, w.actor, row.id, {
        wecomUserid: "lyxtest_member",
        takeOver: false,
      }),
    ).rejects.toMatchObject({ error: "WECOM_USERID_TAKEN" });
    await w.service.bindWecom(w.ctx, w.actor, row.id, {
      wecomUserid: "lyxtest_member",
      takeOver: true,
    });
    expect(
      (await w.prisma.staff.findUniqueOrThrow({ where: { id: other.id } })).wecomUserid,
    ).toBeNull();
  });
  it("分配池整批替换保留客服当班状态，非客服/错角色拒绝", async () => {
    const cs = await w.person("cs");
    await w.service.replacePools(
      w.ctx,
      w.actor,
      cs.id,
      StaffPoolMembershipReplaceBodySchema.parse({
        memberships: [{ pool: "cs" }],
        lockVersion: cs.lockVersion,
      }),
    );
    const csCtx = await import("../testing/index.js").then((m) =>
      m.sampleStaffContext(w.prisma, cs.id),
    );
    await w.service.duty(csCtx, w.actor, cs.id, { onDuty: false });
    const current = await w.prisma.staff.findUniqueOrThrow({ where: { id: cs.id } });
    await w.service.replacePools(
      w.ctx,
      w.actor,
      cs.id,
      StaffPoolMembershipReplaceBodySchema.parse({
        memberships: [{ pool: "cs" }],
        lockVersion: current.lockVersion,
      }),
    );
    expect(
      (await w.prisma.assignmentPoolMember.findFirstOrThrow({ where: { staffId: cs.id } })).onDuty,
    ).toBe(false);
    await expect(
      w.service.replacePools(
        w.ctx,
        w.actor,
        cs.id,
        StaffPoolMembershipReplaceBodySchema.parse({
          memberships: [{ pool: "editor" }],
          lockVersion: current.lockVersion + 1,
        }),
      ),
    ).rejects.toMatchObject({ error: "POOL_ROLE_MISMATCH" });
  });
  it("会话列表只读/真实吊销、当前会话禁止，解锁不写auth_event", async () => {
    const signed = await signInAsStaff(w.prisma, { roleKey: "finance", now: w.clock.now() });
    const before = await w.prisma.authEvent.count();
    const page = await w.service.sessions(
      w.ctx,
      StaffSessionListQuerySchema.parse({ staffId: signed.staff.id }),
      null,
    );
    expect(page.items.map((r) => r.staffSessionId)).toContain(signed.sessionId);
    await expect(
      w.service.revokeSession(w.ctx, w.actor, signed.sessionId, signed.sessionId),
    ).rejects.toMatchObject({ error: "SELF_OPERATION_FORBIDDEN" });
    await w.service.revokeSession(w.ctx, w.actor, signed.sessionId, null);
    expect(
      (await w.prisma.staffSession.findUniqueOrThrow({ where: { id: signed.sessionId } }))
        .revokeReason,
    ).toBe("admin");
    await w.prisma.staff.update({
      where: { id: signed.staff.id },
      data: { failTrusted: 2, failUntrusted: 3 },
    });
    await w.service.unlock(w.ctx, w.actor, signed.staff.id, { bucket: "trusted" });
    expect(
      await w.prisma.staff.findUniqueOrThrow({ where: { id: signed.staff.id } }),
    ).toMatchObject({ failTrusted: 0, failUntrusted: 3 });
    expect(await w.prisma.authEvent.count()).toBe(before);
  });
});
