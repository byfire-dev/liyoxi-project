import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApproval } from "../approval/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdempotencyContext,
  createIdentityContext,
  uuidv7,
} from "../kernel/index.js";
import type { Assembly } from "../kernel/index.js";
import { encryptField } from "../security/index.js";
import { billingCloseFactsPort, clearAccountMemberNamesIn, createTenant } from "../tenant/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import {
  assembleForTest,
  seedBillingDeletionFacts,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import {
  buildHarness,
  keyring,
  META,
  nextOpenid,
  nextPhone,
  TEST_APPID,
} from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { findI24Violations } from "./invariants.js";
import { createIdentity } from "./service.js";
import type { SessionPrincipal } from "./types.js";
const db = useSeededDatabase("services", { label: "deletion", max: 1 });
let h: Harness;
const assembly = assembleForTest({ entry: "api" });
function stack(on = assembly, failEvent = false) {
  const events = createEvents({ tx: h.tx, clock: h.clock, assembly: on });
  if (failEvent) {
    const real = events.emit;
    vi.spyOn(events, "emit").mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[2].type === "merchant_user.deleted") throw new Error("lyxtest deletion rollback");
      return result;
    });
  }
  const flow = createFlow({ clock: h.clock, assembly: on, events }),
    timers = createTimers({ assembly: on });
  const tenant = createTenant({
    tx: h.tx,
    clock: h.clock,
    flow,
    events,
    assembly: on,
    entityClose: { assembly: on, timers },
  });
  const approval = createApproval({
    clock: h.clock,
    assembly: on,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const identity = createIdentity({
    tx: h.tx,
    clock: h.clock,
    flow,
    events,
    assembly: on,
    tenant,
    approval,
    docs: h.docs,
    config: {
      params: { get: async () => 180 },
      flags: { minClientVersion: async () => "0.0.0" },
    } as never,
    keyring: () => keyring,
    wechat: h.wechat,
    appid: TEST_APPID,
  });
  return { identity, tenant, flow, timers };
}
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 120_000);
afterEach(() => {
  vi.restoreAllMocks();
});
async function user() {
  const phone = nextPhone(),
    openid = nextOpenid();
  const login = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid }),
    consents: h.consents(),
  });
  const auth = await h.identity.authenticate(login.token, { ip: META.ip });
  if (!auth.ok) throw new Error("真实登录没有形成当前会话");
  const principal = auth.principal;
  return {
    phone,
    openid,
    token: login.token,
    principal,
    id: principal.merchantUserId,
    ctx: createIdentityContext({
      actor: { type: "merchant", id: principal.merchantUserId, client: "weapp" },
      ...META,
    }),
  };
}
const idem = (principal: SessionPrincipal, key = uuidv7()) => ({
  idem: createIdempotencyContext({
    mode: "required",
    scope: "m.me.deletion.create",
    key,
    actor: { type: "merchant", id: principal.merchantUserId, client: "weapp", role: null },
    request: { method: "POST", pathParams: {}, body: { hasConfirmed: true }, storeId: null },
  }),
});
async function owner() {
  const who = await user(),
    service = stack();
  const created = await service.tenant.createEntity(who.ctx);
  return { ...who, ...created };
}
async function history(who: Awaited<ReturnType<typeof user>>) {
  const entity = await h.make.entity({ createdByUserId: who.id });
  return h.make.entityMember({
    entityId: entity.id,
    merchantUserId: who.id,
    status: "removed",
    displayName: "历史称呼",
    removedAt: h.clock.now(),
    removeReason: "self",
    removeActorType: "merchant",
    removeActorId: who.id,
    removeClient: "weapp",
  });
}
async function pendingChange(who: Awaited<ReturnType<typeof user>>) {
  const staff = await h.make.staff({ staffRoleKey: "cs" }),
    now = h.clock.now();
  const approval = await h.prisma.approvalRequest.create({
    data: {
      id: uuidv7(),
      requestNo: `ZH${uuidv7().replaceAll("-", "")}`,
      kind: "account_change",
      category: "approval",
      subjectType: "merchant_user",
      subjectId: who.id,
      status: "pending",
      summarySnapshot: { title: "账号核实" },
      submitActorType: "staff",
      submitActorId: staff.id,
      submitClient: "admin",
      requesterStaffId: staff.id,
      submittedAt: now,
      dedupeKey: `account_change:phone_rebind:${who.id}`,
      createdAt: now,
      updatedAt: now,
    },
  });
  const request = await h.prisma.accountChangeRequest.create({
    data: {
      id: uuidv7(),
      approvalRequestId: approval.id,
      kind: "phone_rebind",
      merchantUserId: who.id,
      newPhoneEnc: encryptField(keyring, "account_change_request.new_phone_enc", nextPhone()),
      newPhoneMask: "138****0001",
      proofFileIds: [uuidv7()],
      reasonCode: "other",
      reasonText: "虚构核实",
      createdAt: now,
      updatedAt: now,
    },
  });
  return { approval, request, staff };
}
const tables = [
  "merchant_user",
  "wechat_identity",
  "user_session",
  "portal_session",
  "sms_verification",
  "merchant_user_notice",
  "wecom_contact",
  "wx_subscribe_quota",
  "entity",
  "entity_member",
  "store",
  "store_member",
  "invitation",
  "timer",
  "approval_request",
  "account_change_request",
  "status_transition",
  "audit_log",
  "outbox_event",
  "agreement_consent",
];
const deleteAs = (who: Awaited<ReturnType<typeof user>>, service = stack(), key = uuidv7()) =>
  service.identity.deleteAccount(
    who.principal,
    META,
    { hasConfirmed: true },
    idem(who.principal, key),
  );

describe("账号注销的真实清理、阻断与同事务边界", { timeout: 120_000 }, () => {
  it("无成员清所有个人依附并系统代撤，证据保留；same-key401且原号码可新建账号", async () => {
    const who = await user(),
      old = await history(who),
      change = await pendingChange(who),
      now = h.clock.now();
    const wi = await h.prisma.wechatIdentity.findFirstOrThrow({
      where: { merchantUserId: who.id },
    });
    await h.prisma.wxSubscribeQuota.create({
      data: {
        wechatIdentityId: wi.id,
        merchantUserId: who.id,
        wxTemplateSlotKey: "member_change",
        estRemaining: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.smsVerification.create({
      data: {
        id: uuidv7(),
        purpose: "phone_change",
        merchantUserId: who.id,
        phoneBidx: Buffer.alloc(32, 1),
        codeHash: Buffer.alloc(32, 2),
        expiresAt: new Date(now.getTime() + 300000),
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.merchantUserNotice.create({
      data: {
        id: uuidv7(),
        merchantUserId: who.id,
        kind: "new_wechat_bound",
        occurredAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.wecomContact.create({
      data: {
        id: uuidv7(),
        merchantUserId: who.id,
        staffId: change.staff.id,
        externalUseridEnc: encryptField(
          keyring,
          "wecom_contact.external_userid_enc",
          "fictional-contact",
        ),
        externalUseridBidx: Buffer.alloc(32, 3),
        addedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const consents = await h.prisma.agreementConsent.findMany({
        where: { merchantUserId: who.id },
      }),
      key = uuidv7();
    expect(await deleteAs(who, stack(), key)).toEqual({ deletedAt: now.toISOString() });
    expect(await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: who.id } })).toMatchObject({
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
    });
    expect(await findI24Violations(h.prisma)).toEqual([]);
    expect(await h.prisma.wxSubscribeQuota.count({ where: { merchantUserId: who.id } })).toBe(0);
    expect(await h.prisma.entityMember.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      displayName: null,
      status: "removed",
      removeReason: "self",
    });
    expect(
      await h.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: change.request.id } }),
    ).toMatchObject({ newPhoneEnc: null });
    expect(
      await h.prisma.approvalRequest.findUniqueOrThrow({ where: { id: change.approval.id } }),
    ).toMatchObject({ status: "withdrawn", isDecidedBySystem: true });
    expect(await h.prisma.agreementConsent.findMany({ where: { merchantUserId: who.id } })).toEqual(
      consents,
    );
    const audit = await h.prisma.auditLog.findFirstOrThrow({
      where: { targetId: who.id, action: "identity.merchant_user.delete" },
    });
    expect(audit.actorType).toBe("merchant");
    expect(
      await h.prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: who.id, eventType: "merchant_user.deleted" },
      }),
    ).toMatchObject({ payload: { reason: "self_deleted" } });
    await expect(deleteAs(who, stack(), key)).rejects.toMatchObject({ error: "SESSION_INVALID" });
    const login = await h.identity.phoneLogin(META, {
      ...h.codes({ phone: who.phone, openid: nextOpenid() }),
      consents: h.consents(),
    });
    expect(login.me.user.merchantUserId).not.toBe(who.id);
  });
  it("店员当前关系account_deleted，本人多个旧主体历史称呼归零；其他成员与主体不受影响", async () => {
    const who = await user(),
      old = await history(who),
      host = await owner();
    const member = await h.make.entityMember({
      entityId: host.entityId,
      merchantUserId: who.id,
      displayName: "当前店员",
    });
    await h.make.storeMember({
      entityMemberId: member.id,
      storeId: host.storeId,
      addedByMemberId: host.memberId,
    });
    await deleteAs(who);
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: member.id } }),
    ).toMatchObject({
      status: "removed",
      displayName: null,
      removeReason: "account_deleted",
      removeActorType: "merchant",
      removeActorId: who.id,
      removeClient: "weapp",
    });
    expect(await h.prisma.entityMember.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      displayName: null,
    });
    expect(await h.prisma.storeMember.count({ where: { entityMemberId: member.id } })).toBe(0);
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: host.entityId } })).toMatchObject(
      { lifecycle: "active" },
    );
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: host.memberId } }),
    ).toMatchObject({ status: "active" });
  });
  it("老板六项为零调用原tenant级联：邀请计时器/成员/两店/全部portal同Tx关闭且历史交易保留", async () => {
    const who = await user(),
      old = await history(who),
      created = await stack().tenant.createEntity(who.ctx);
    const host = { ...who, ...created },
      second = await h.make.store({ entityId: host.entityId });
    const clerk = await user(),
      cm = await h.make.entityMember({
        entityId: host.entityId,
        merchantUserId: clerk.id,
        displayName: "保留店员名",
      });
    await h.make.storeMember({
      entityMemberId: cm.id,
      storeId: host.storeId,
      addedByMemberId: host.memberId,
    });
    const now = h.clock.now(),
      invitation = await h.prisma.invitation.create({
        data: {
          id: uuidv7(),
          entityId: host.entityId,
          storeId: host.storeId,
          inviterMemberId: host.memberId,
          role: "clerk",
          status: "pending",
          tokenHash: Buffer.alloc(32, 7),
          tokenEnc: encryptField(keyring, "invitation.token_enc", "fictional-token"),
          clientRequestId: uuidv7(),
          expiresAt: new Date(now.getTime() + 86400000),
          createdAt: now,
          updatedAt: now,
        },
      });
    const service = stack();
    await h.tx.run((tx) =>
      service.timers.arm(tx, {
        subject: { type: "invitation", id: invitation.id },
        kind: "invitation.expire",
        key: timerKey("invitation.expire", { type: "invitation", id: invitation.id }),
        fireAt: invitation.expiresAt,
        entityId: host.entityId,
        storeId: host.storeId,
      }),
    );
    const portal = await h.prisma.portalSession.create({
      data: {
        id: uuidv7(),
        tokenHash: Buffer.alloc(32, 9),
        portalTicketId: uuidv7(),
        approvedByUserId: host.id,
        entityId: host.entityId,
        storeId: host.storeId,
        grantScope: "store",
        expiresAt: new Date(now.getTime() + 7200000),
        ip: META.ip!,
        userAgent: META.userAgent!,
        createdAt: now,
        updatedAt: now,
      },
    });
    const paid = await h.make.billingOrder({ entityId: host.entityId });
    await deleteAs(host, service);
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: host.entityId } })).toMatchObject(
      { lifecycle: "closed" },
    );
    expect(
      await h.prisma.store.findMany({ where: { id: { in: [host.storeId, second.id] } } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lifecycle: "archived", archiveReason: "entity_closed" }),
      ]),
    );
    expect(
      await h.prisma.store.count({ where: { entityId: host.entityId, lifecycle: "active" } }),
    ).toBe(0);
    expect(
      await h.prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } }),
    ).toMatchObject({
      status: "revoked",
      tokenEnc: null,
      revokeActorId: host.id,
      revokeClient: "weapp",
    });
    expect(
      await h.prisma.timer.findFirstOrThrow({ where: { subjectId: invitation.id } }),
    ).toMatchObject({ status: "cancelled" });
    expect(await h.prisma.entityMember.findUniqueOrThrow({ where: { id: cm.id } })).toMatchObject({
      status: "removed",
      removeReason: "entity_closed",
      displayName: "保留店员名",
    });
    expect(await h.prisma.entityMember.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      displayName: null,
    });
    expect(await h.prisma.portalSession.findUnique({ where: { id: portal.id } })).toBeNull();
    expect(await h.prisma.billingOrder.findUniqueOrThrow({ where: { id: paid.id } })).toEqual(paid);
    expect(await h.identity.authenticate(clerk.token, { ip: META.ip })).toMatchObject({ ok: true });
  });
  it("六类真实非零阻断均返回且零类不列；失败不改账号、主体、会话和审批", async () => {
    const finance = await owner();
    await h.tx.run((tx) =>
      seedBillingDeletionFacts(tx, h.clock, { entityId: finance.entityId, userId: finance.id }),
    );
    const order = await owner(),
      term = await h.make.subscriptionTerm({ entityId: order.entityId, status: "ended" });
    await h.make.dramaOrder({
      entityId: order.entityId,
      storeId: order.storeId,
      placedByUserId: order.id,
      subscriptionTermId: term.id,
    });
    const release = await owner(),
      rt = await h.make.subscriptionTerm({ entityId: release.entityId, status: "ended" });
    const ended = await h.make.dramaOrder({
      entityId: release.entityId,
      storeId: release.storeId,
      placedByUserId: release.id,
      subscriptionTermId: rt.id,
      status: "ended",
    });
    const item = await h.make.orderItem({ dramaOrderId: ended.id, phase: "ended" });
    await h.make.deliveryTicket({ orderItemId: item.id, step: "in_service" });
    for (const [who, blockers] of [
      [
        finance,
        [
          { kind: "subscription_active", count: 2 },
          { kind: "payment_open", count: 4 },
          { kind: "refund_open", count: 1 },
          { kind: "invoice_open", count: 2 },
        ],
      ],
      [order, [{ kind: "open_order", count: 1 }]],
      [release, [{ kind: "release_online", count: 1 }]],
    ] as const) {
      const before = await snapshotTables(h.prisma, tables);
      await expect(deleteAs(who)).rejects.toMatchObject({
        error: "ACCOUNT_DELETION_BLOCKED",
        details: { blockers },
      });
      expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    }
  });
  it("事实来源异常原样传播并整笔回滚，缺装配不伪造零放行", async () => {
    const who = await owner(),
      failure = new Error("真实事实出口不可用"),
      before = await snapshotTables(h.prisma, tables);
    const unavailable: Assembly = {
      ...assembly,
      port: ((port: unknown) => {
        if (port === billingCloseFactsPort) throw failure;
        return assembly.port(port as never);
      }) as Assembly["port"],
    };
    await expect(deleteAs(who, stack(unavailable))).rejects.toBe(failure);
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  });
  it("tenant联动之后事件写入失败，全历史称呼/账号/申请/成员/门店/会话和审计都回滚", async () => {
    const who = await user();
    await history(who);
    await stack().tenant.createEntity(who.ctx);
    await pendingChange(who);
    const before = await snapshotTables(h.prisma, tables);
    await expect(deleteAs(who, stack(assembly, true))).rejects.toThrow("lyxtest deletion rollback");
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    expect(await h.identity.authenticate(who.token, { ip: META.ip })).toMatchObject({ ok: true });
  });
  it("不得直接伪造delete flow授权或在尚有active成员时清称呼，未确认和失效session零写", async () => {
    const who = await owner(),
      service = stack(),
      before = await snapshotTables(h.prisma, tables);
    await expect(
      h.tx.run((tx) =>
        service.flow.transition(tx, who.ctx, {
          machine: "merchant_user",
          stateField: "status",
          id: who.id,
          event: "merchant_user.delete",
          ref: "02:128",
          args: { confirmed: true, noBlockers: true },
          audit: {
            stream: "ops",
            category: "account_security",
            action: "identity.merchant_user.delete",
            summary: "伪造注销",
          },
          emit: {
            type: "merchant_user.deleted",
            payload: { v: 1, merchantUserId: who.id, reason: "self_deleted" },
          },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(
      h.tx.run((tx) => clearAccountMemberNamesIn(tx, who.ctx, h.clock.now())),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(
      service.identity.deleteAccount(who.principal, META, { hasConfirmed: false } as never),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  });
  it("I24登记实际检查残余个人行与历史名字，不把依法留存的同意/审计当作残留", async () => {
    const who = await user();
    await deleteAs(who);
    expect(await findI24Violations(h.prisma)).toEqual([]);
    const now = h.clock.now(),
      notice = await h.prisma.merchantUserNotice.create({
        data: {
          id: uuidv7(),
          merchantUserId: who.id,
          kind: "new_wechat_bound",
          occurredAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
    expect(await findI24Violations(h.prisma)).toEqual([
      {
        subject: { type: "merchant_user", id: who.id },
        detail: { problem: "residual_personal_data" },
      },
    ]);
    await h.prisma.merchantUserNotice.delete({ where: { id: notice.id } });
    expect(await findI24Violations(h.prisma)).toEqual([]);
  });
});
