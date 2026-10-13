import type { AccountChangeCreateBody, AccountChangeRequestDetail } from "@liyoxi/contract";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApproval } from "../approval/index.js";
import { buildStaffContext, isStaffRoleKey, normalizeRoleConfig } from "../authz/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdempotencyContext,
  createIdentityContext,
  createTxRunner,
  fileRefTypePort,
  uuidv7,
} from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import { createNotifyDispatcher } from "../notify/index.js";
import { blindIndex, decryptField } from "../security/index.js";
import {
  assembleForTest,
  createClock,
  notificationFixture,
  signInAsStaff,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { createAccountChanges } from "./account-changes.js";
import { findI26Violations } from "./invariants.js";
import {
  buildHarness,
  keyring,
  META,
  nextOpenid,
  nextPhone,
  openClient,
} from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";

const db = useSeededDatabase("services", { label: "acctchange", max: 1 });
const assembly = assembleForTest({ entry: "api" });
const DAY = 86400000;
const TABLES = [
  "account_change_request",
  "approval_request",
  "merchant_user",
  "wechat_identity",
  "user_session",
  "portal_session",
  "entity_member",
  "store_member",
  "file_ref",
  "status_transition",
  "audit_log",
  "outbox_event",
  "idempotency_record",
];
let h: Harness, notify: ReturnType<typeof createNotifyDispatcher>;
let services: ReturnType<typeof stack>;
function stack(client = h.prisma, failEvent?: string, clock: Clock = h.clock) {
  const tx = createTxRunner({ prisma: client, appEnv: "test" });
  const events = createEvents({ tx, clock, assembly });
  if (failEvent) {
    const real = events.emit;
    vi.spyOn(events, "emit").mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[2].type === failEvent) throw new Error("lyxtest account apply rollback");
      return result;
    });
  }
  const flow = createFlow({ clock, assembly, events });
  const approval = createApproval({
    clock,
    assembly,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const media = createMedia({
    tx,
    clock,
    assembly,
    events,
    storage: h.providers.providers.storage,
  });
  const changes = createAccountChanges({
    tx,
    clock,
    flow,
    events,
    assembly,
    keyring: () => keyring,
    approval,
    media,
    notify,
    smsConfigured: () => true,
  });
  return { tx, events, flow, approval, media, changes };
}
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
  const fixture = notificationFixture(h.prisma);
  notify = createNotifyDispatcher({
    ...fixture.deps,
    tx: h.tx,
    clock: h.clock,
    providers: h.providers.providers,
    directTarget: (phone) => ({
      phoneRef: blindIndex(keyring, "phone", phone).toString("hex"),
      phoneMask: `138****${phone.slice(-4)}`,
    }),
  });
  await h.prisma.smsTemplate.updateMany({
    where: { templateKey: "account_notice" },
    data: {
      status: "active",
      providerTemplateId: "fictional-template",
      signName: "虚构公司",
      updatedAt: h.clock.now(),
    },
  });
  await h.prisma.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "account_change_reason",
      code: "MANUAL01",
      name: "账号人工核实",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  services = stack();
}, 120000);
afterAll(async () => {
  await notify?.close();
});
afterEach(() => vi.restoreAllMocks());
async function actor(
  roleKey: "cs" | "super_admin" | "delivery_manager" = "cs",
  isLead = false,
  stale = false,
) {
  const signed = await signInAsStaff(h.prisma, {
    roleKey,
    isLead,
    now: new Date(h.clock.now().getTime() - (stale ? 660000 : 0)),
  });
  const row = signed.staff;
  if (!isStaffRoleKey(row.staffRoleKey)) throw new Error("测试角色未登记");
  const role = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: row.staffRoleKey } });
  const staff = buildStaffContext({
    staff: {
      id: row.id,
      roleKey: row.staffRoleKey,
      staffGroupId: row.staffGroupId,
      isLead: row.isLead,
    },
    role: normalizeRoleConfig(row.staffRoleKey, role),
    groupStaffIds: [row.id],
    stepUpAt: stale ? new Date(h.clock.now().getTime() - 660000) : h.clock.now(),
  });
  const ctx = createIdentityContext({
    actor: { type: "staff", id: row.id, client: "admin" },
    ...META,
  });
  return {
    signed,
    staff,
    ctx,
    meta: { ...META, sessionId: signed.sessionId, authMethod: "password+totp" as const },
  };
}
type Caller = Awaited<ReturnType<typeof actor>>;
async function user(withEntity = true, dormant = false) {
  const phone = nextPhone();
  const login = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid: nextOpenid() }),
    consents: h.consents(),
  });
  const auth = await h.identity.authenticate(login.token, { ip: META.ip });
  if (!auth.ok) throw new Error("真实登录未形成会话");
  const id = auth.principal.merchantUserId;
  const entity = withEntity ? await h.make.entity({ createdByUserId: id }) : null;
  const store = entity ? await h.make.store({ entityId: entity.id, isPrimary: true }) : null;
  const member = entity
    ? await h.make.entityMember({ entityId: entity.id, merchantUserId: id, role: "owner" })
    : null;
  if (dormant)
    await h.prisma.merchantUser.update({
      where: { id },
      data: { lastActiveAt: new Date(h.clock.now().getTime() - 181 * DAY) },
    });
  const row = await h.prisma.merchantUser.findUniqueOrThrow({ where: { id } });
  return { id, phone, login, principal: auth.principal, entity, store, member, row };
}
type User = Awaited<ReturnType<typeof user>>;
async function proof(caller: Caller, entityId: string | null) {
  return h.make.fileObject({
    category: "account_proof",
    bucket: "secure",
    scopeType: entityId ? "entity" : "platform",
    entityId,
    uploadActorType: "staff",
    uploadActorId: caller.staff.staff.id,
    uploadClient: "admin",
    ext: "pdf",
    mime: "application/pdf",
    declaredMime: "application/pdf",
  });
}
function options(caller: Caller, op: string, body: unknown, id?: string, key = uuidv7()) {
  return {
    meta: caller.meta,
    idem: createIdempotencyContext({
      mode: "required",
      scope: `admin.accountChangeRequest.${op}`,
      key,
      actor: caller.ctx.actor,
      request: {
        method: "POST",
        pathParams: id ? { accountChangeRequestId: id } : {},
        body,
        storeId: null,
      },
    }),
  };
}
async function submit(
  caller: Caller,
  who: User,
  kind: AccountChangeCreateBody["kind"] = "owner_reverify",
  newPhone = nextPhone(),
  s = services,
) {
  const base = {
    reasonCode: "MANUAL01",
    reasonText: "线下核实账号归属",
    confirm: { targetPhoneMask: who.row.phoneMask! },
  };
  let body: AccountChangeCreateBody;
  if (kind === "owner_reverify")
    body = {
      ...base,
      kind,
      merchantUserId: who.id,
      proofFileIds: [],
      verifyMethod: "核实合同",
      verifyRecord: "已核实近期合同与付款",
    };
  else {
    const file = await proof(caller, who.entity?.id ?? null);
    body =
      kind === "phone_rebind"
        ? { ...base, kind, merchantUserId: who.id, newPhone, proofFileIds: [file.id] }
        : { ...base, kind, entityId: who.entity!.id, newPhone, proofFileIds: [file.id] };
  }
  return {
    body,
    detail: await s.changes.create(caller.ctx, caller.staff, body, options(caller, "create", body)),
  };
}
const approvalBody = (detail: AccountChangeRequestDetail) => ({
  lockVersion: detail.approval.lockVersion,
  confirm: { requestNo: detail.requestNo, newPhoneMask: detail.newPhoneMask },
  confirmChecks: ["proof_checked"],
});
function approve(caller: Caller, detail: AccountChangeRequestDetail, s = services, key = uuidv7()) {
  const body = approvalBody(detail);
  return s.changes.approve(
    caller.ctx,
    caller.staff,
    detail.accountChangeRequestId,
    body,
    options(caller, "approve", body, detail.accountChangeRequestId, key),
  );
}
const persisted = (detail: AccountChangeRequestDetail) =>
  h.prisma.accountChangeRequest.findUniqueOrThrow({
    where: { id: detail.accountChangeRequestId },
    include: { approvalRequest: true },
  });
const smsFor = (phone: string) =>
  h.providers.providers.sms
    .callsOf("sendSubscribeFallback")
    .filter((call) => (call.input as { phone: string }).phone === phone);
async function portal(who: User) {
  const entity = who.entity ?? (await h.make.entity({ createdByUserId: who.id }));
  const store = who.store ?? (await h.make.store({ entityId: entity.id }));
  return h.prisma.portalSession.create({
    data: {
      id: uuidv7(),
      portalTicketId: uuidv7(),
      tokenHash: Buffer.from(uuidv7().replaceAll("-", "")),
      approvedByUserId: who.id,
      entityId: entity.id,
      storeId: store.id,
      grantScope: "store",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
      expiresAt: new Date(h.clock.now().getTime() + DAY),
      ip: META.ip!,
      userAgent: "lyxtest account change",
    },
  });
}

describe("人工账号变更三类真实闭环", { timeout: 120000 }, () => {
  it("创建复核保留真实审批与去重键；GET现算提示零写且不泄露手机号", async () => {
    const requester = await actor(),
      who = await user(true, true);
    const { body, detail } = await submit(requester, who);
    const row = await persisted(detail);
    expect(row.approvalRequest).toMatchObject({
      kind: "account_change",
      category: "approval",
      submitActorType: "staff",
      submitClient: "admin",
      requesterStaffId: requester.staff.staff.id,
      dedupeKey: `account_change:owner_reverify:${who.id}`,
      dueAt: null,
      slaSnapshot: null,
    });
    expect(detail).toMatchObject({
      kind: "owner_reverify",
      appliedAt: null,
      precheck: { ok: true, issues: [] },
      result: null,
    });
    expect(row.approvalRequest.requestNo).toMatch(/^ZH/);
    await expect(
      services.changes.create(
        requester.ctx,
        requester.staff,
        body,
        options(requester, "create", body),
      ),
    ).rejects.toMatchObject({ error: "APPROVAL_ALREADY_PENDING" });
    const before = await snapshotTables(h.prisma, TABLES);
    const got = await services.changes.get(
      requester.ctx,
      requester.staff,
      detail.accountChangeRequestId,
      { meta: requester.meta },
    );
    const list = await services.changes.list(
      requester.ctx,
      requester.staff,
      { page: 1, pageSize: 20, merchantUserId: who.id },
      { meta: requester.meta },
    );
    expect(list.total).toBe(1);
    expect(list.items[0]?.accountChangeRequestId).toBe(detail.accountChangeRequestId);
    expect(JSON.stringify([got, list, row.approvalRequest.summarySnapshot])).not.toContain(
      who.phone,
    );
    expect(JSON.stringify(got)).not.toMatch(/phoneEnc|newPhoneEnc|tokenHash|https?:\/\//);
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });

  it("复核通过写72小时旁路；同键不重复审计但仍复核员工会话", async () => {
    const requester = await actor(),
      decider = await actor("cs", true),
      who = await user(true, true);
    const { detail } = await submit(requester, who),
      key = uuidv7();
    const result = await approve(decider, detail, services, key);
    expect(result.result).toEqual({
      bypassUntil: new Date(h.clock.now().getTime() + 72 * 3600000).toISOString(),
    });
    const after = await snapshotTables(h.prisma, TABLES);
    expect(await approve(decider, detail, services, key)).toEqual(result);
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(after);
    const row = await persisted(detail);
    expect(row).toMatchObject({ appliedAt: h.clock.now(), newPhoneEnc: null });
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: row.approvalRequestId, action: "identity.account_change.approve" },
      }),
    ).toBe(1);
    await h.prisma.staffSession.update({
      where: { id: decider.signed.sessionId },
      data: { revokedAt: h.clock.now(), revokeReason: "admin" },
    });
    await expect(approve(decider, detail, services, key)).rejects.toMatchObject({
      error: "SESSION_INVALID",
    });
    expect(await findI26Violations(h.prisma)).toEqual([]);
  });

  it("审批换绑吊销目标全部商家会话、保留下载授权，提交后只通知旧号一次", async () => {
    const requester = await actor(),
      decider = await actor("cs", true),
      who = await user();
    await h.identity.phoneLogin(META, {
      ...h.codes({ phone: who.phone, openid: nextOpenid() }),
      consents: h.consents(),
    });
    const grant = await portal(who),
      phone = nextPhone(),
      { detail } = await submit(requester, who, "phone_rebind", phone),
      key = uuidv7();
    const beforeSms = smsFor(who.phone).length;
    const result = await approve(decider, detail, services, key);
    expect(result.result).toEqual({ purgedUserId: null, prevPhoneMask: who.row.phoneMask });
    const changed = await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: who.id } });
    expect(decryptField(keyring, "merchant_user.phone_enc", changed.phoneEnc!)).toBe(phone);
    expect(
      await h.prisma.userSession.count({ where: { merchantUserId: who.id, revokedAt: null } }),
    ).toBe(0);
    expect(
      await h.prisma.userSession.count({
        where: { merchantUserId: who.id, revokeReason: "phone_change" },
      }),
    ).toBe(2);
    expect(await h.prisma.portalSession.findUnique({ where: { id: grant.id } })).toMatchObject({
      revokedAt: null,
    });
    expect((await persisted(detail)).newPhoneEnc).toBeNull();
    expect(smsFor(who.phone)).toHaveLength(beforeSms + 1);
    await approve(decider, detail, services, key);
    expect(smsFor(who.phone)).toHaveLength(beforeSms + 1);
    const logs = await h.prisma.auditLog.findMany({
      where: { targetId: (await persisted(detail)).approvalRequestId },
    });
    const json = JSON.stringify(logs, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(json).not.toContain(phone);
    expect(json).not.toContain(who.phone);
  });

  it("新号空账号清个人依附并同事务系统撤回其申请，保留历史同意", async () => {
    const requester = await actor("super_admin"),
      decider = await actor("cs", true),
      who = await user(),
      occupant = await user(false);
    const pending = await submit(requester, occupant, "phone_rebind");
    const consentCount = await h.prisma.agreementConsent.count({
      where: { merchantUserId: occupant.id },
    });
    await h.prisma.merchantUserNotice.create({
      data: {
        id: uuidv7(),
        merchantUserId: occupant.id,
        kind: "new_wechat_bound",
        occurredAt: h.clock.now(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const { detail } = await submit(requester, who, "phone_rebind", occupant.phone);
    expect(detail.precheck).toEqual({ ok: true, issues: ["phone_occupied_by_empty_account"] });
    expect((await approve(decider, detail)).result).toEqual({
      purgedUserId: occupant.id,
      prevPhoneMask: who.row.phoneMask,
    });
    expect(await h.prisma.merchantUser.findUnique({ where: { id: occupant.id } })).toMatchObject({
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      displayName: null,
    });
    expect(await h.prisma.wechatIdentity.count({ where: { merchantUserId: occupant.id } })).toBe(0);
    expect(await h.prisma.userSession.count({ where: { merchantUserId: occupant.id } })).toBe(0);
    expect(
      await h.prisma.merchantUserNotice.count({ where: { merchantUserId: occupant.id } }),
    ).toBe(0);
    expect(await h.prisma.agreementConsent.count({ where: { merchantUserId: occupant.id } })).toBe(
      consentCount,
    );
    expect(await persisted(pending.detail)).toMatchObject({
      newPhoneEnc: null,
      appliedAt: null,
      approvalRequest: { status: "withdrawn" },
    });
    expect(await findI26Violations(h.prisma)).toEqual([]);
  });

  it("老板更换将本主体店员就地晋升，先移旧老板并吊销其下载授权", async () => {
    const requester = await actor(),
      decider = await actor("cs", true),
      who = await user(),
      candidate = await user(false);
    const clerk = await h.make.entityMember({
      entityId: who.entity!.id,
      merchantUserId: candidate.id,
      role: "clerk",
      displayName: "新老板",
      lastStoreId: who.store!.id,
    });
    await h.prisma.storeMember.create({
      data: {
        entityMemberId: clerk.id,
        storeId: who.store!.id,
        entityId: who.entity!.id,
        addedByMemberId: who.member!.id,
        createdAt: h.clock.now(),
      },
    });
    const grant = await portal(who),
      { detail } = await submit(requester, who, "owner_transfer", candidate.phone);
    expect((await approve(decider, detail)).result).toEqual({
      newOwnerUserId: candidate.id,
      newOwnerAccountCreated: false,
      newOwnerMemberId: clerk.id,
      prevOwnerMemberId: who.member!.id,
    });
    expect(await h.prisma.entityMember.findUnique({ where: { id: who.member!.id } })).toMatchObject(
      {
        status: "removed",
        removeReason: "owner_transfer",
        removeActorType: "staff",
        removeActorId: decider.staff.staff.id,
      },
    );
    expect(await h.prisma.entityMember.findUnique({ where: { id: clerk.id } })).toMatchObject({
      status: "active",
      role: "owner",
      lastStoreId: null,
    });
    expect(await h.prisma.storeMember.count({ where: { entityMemberId: clerk.id } })).toBe(0);
    expect(
      await h.prisma.entityMember.count({
        where: { entityId: who.entity!.id, role: "owner", status: "active" },
      }),
    ).toBe(1);
    expect(await h.prisma.portalSession.findUnique({ where: { id: grant.id } })).toMatchObject({
      revokeReason: "membership_changed",
      revokedAt: h.clock.now(),
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "entity_member.promoted", aggregateId: clerk.id },
      }),
    ).toBe(1);
    const transitions = await h.prisma.statusTransition.findMany({
      where: { subjectId: { in: [who.member!.id, clerk.id] } },
      orderBy: { seq: "asc" },
    });
    expect(transitions.map((row) => row.event)).toEqual([
      "entity_member.cascade_remove",
      "entity_member.promote_owner",
    ]);
  });

  it("老板更换新建真实organic账号而不伪造协议同意，普通初登守卫仍拒绝旁路", async () => {
    const requester = await actor(),
      decider = await actor("cs", true),
      who = await user(),
      phone = nextPhone();
    const { detail } = await submit(requester, who, "owner_transfer", phone),
      result = await approve(decider, detail);
    const created = await h.prisma.merchantUser.findUniqueOrThrow({
      where: { phoneBidx: blindIndex(keyring, "phone", phone) },
    });
    expect(result.result).toMatchObject({
      newOwnerUserId: created.id,
      newOwnerAccountCreated: true,
    });
    expect(created).toMatchObject({
      sourceType: "organic",
      sourceReferralCodeId: null,
      consentStamp: null,
      status: "active",
      lastActiveAt: h.clock.now(),
    });
    expect(await h.prisma.agreementConsent.count({ where: { merchantUserId: created.id } })).toBe(
      0,
    );
    expect(
      await h.prisma.outboxEvent.findFirst({
        where: { eventType: "merchant_user.registered", aggregateId: created.id },
      }),
    ).toMatchObject({ payload: { via: "owner_transfer", sourceType: "organic" } });
    const forged = await h.make.merchantUser({ consentStamp: null });
    await expect(
      services.tx.run((tx) =>
        services.flow.transition(tx, decider.ctx, {
          machine: "merchant_user",
          stateField: "status",
          id: forged.id,
          event: "merchant_user.register",
          ref: "02:125",
          created: true,
          args: { via: "owner_transfer", consentComplete: true },
          audit: { mergedInto: { approvalRequestId: result.approval.approvalId } },
          emit: {
            type: "merchant_user.registered",
            payload: {
              v: 1,
              merchantUserId: forged.id,
              via: "owner_transfer",
              sourceType: "organic",
              sourceReferralCodeId: null,
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
    expect(await findI26Violations(h.prisma)).toEqual([]);
  });

  it("通过时真实重算新号历史占用、跨主体与目标状态变化，失败申请保持pending", async () => {
    const requester = await actor(),
      decider = await actor("cs", true);
    for (const branch of ["history", "other_entity", "disabled"] as const) {
      const who = await user(),
        phone = nextPhone(),
        kind = branch === "other_entity" ? "owner_transfer" : "phone_rebind";
      const { detail } = await submit(requester, who, kind, phone);
      if (branch === "disabled")
        await h.prisma.merchantUser.update({ where: { id: who.id }, data: { status: "disabled" } });
      else {
        const occupant = await h.make.merchantUser({ phone });
        const entity = await h.make.entity({ createdByUserId: occupant.id });
        await h.make.entityMember({
          entityId: entity.id,
          merchantUserId: occupant.id,
          role: branch === "history" ? "clerk" : "owner",
          ...(branch === "history"
            ? {
                status: "removed",
                removedAt: h.clock.now(),
                removeActorType: "system",
                removeActorId: null,
                removeClient: null,
                removeReason: "dormant",
                displayName: null,
              }
            : {}),
        });
      }
      await expect(approve(decider, detail)).rejects.toMatchObject({
        error: "PRECONDITION_CHANGED",
        details: {
          reason:
            branch === "history"
              ? "phone_taken"
              : branch === "other_entity"
                ? "new_owner_in_other_entity"
                : "target_not_active",
        },
      });
      const row = await persisted(detail);
      expect(row.approvalRequest.status).toBe("pending");
      expect(row.appliedAt).toBeNull();
      expect(row.newPhoneEnc).not.toBeNull();
    }
  });

  it("审批权限、本人禁止、stepup、版本/回显及证明归属边界均使用真实事实", async () => {
    {
      const requester = await actor("cs", true),
        normal = await actor(),
        stale = await actor("cs", true, true),
        decider = await actor("cs", true),
        who = await user(true, true);
      const { detail } = await submit(requester, who);
      const before = await snapshotTables(h.prisma, TABLES);
      await expect(approve(requester, detail)).rejects.toMatchObject({
        error: "APPROVAL_SELF_FORBIDDEN",
      });
      await expect(approve(normal, detail)).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
      await expect(approve(stale, detail)).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
      const body = { ...approvalBody(detail), lockVersion: detail.approval.lockVersion + 1 };
      await expect(
        services.changes.approve(
          decider.ctx,
          decider.staff,
          detail.accountChangeRequestId,
          body,
          options(decider, "approve", body, detail.accountChangeRequestId),
        ),
      ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
      const wrong = {
        ...approvalBody(detail),
        confirm: { requestNo: "ZH-wrong", newPhoneMask: null },
      };
      await expect(
        services.changes.approve(
          decider.ctx,
          decider.staff,
          detail.accountChangeRequestId,
          wrong,
          options(decider, "approve", wrong, detail.accountChangeRequestId),
        ),
      ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
      expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    }
    {
      const requester = await actor("super_admin"),
        other = await actor("super_admin"),
        manager = await actor("delivery_manager"),
        who = await user(false);
      const registered = await services.media.register(
        { identity: requester.ctx, staff: requester.staff, audit: requester.meta },
        {
          category: "account_proof",
          files: [{ fileName: "account-proof.pdf", sizeBytes: "1024", clientToken: uuidv7() }],
        },
      );
      expect(
        await h.prisma.fileObject.findUnique({ where: { id: registered.items[0]!.fileId } }),
      ).toMatchObject({
        bucket: "secure",
        scopeType: "platform",
        entityId: null,
        storeId: null,
        uploadActorId: requester.staff.staff.id,
      });
      const file = await proof(requester, null),
        body: AccountChangeCreateBody = {
          kind: "phone_rebind",
          merchantUserId: who.id,
          newPhone: nextPhone(),
          proofFileIds: [file.id],
          reasonCode: "MANUAL01",
          reasonText: "无主体账号核实",
          confirm: { targetPhoneMask: who.row.phoneMask! },
        };
      await expect(
        services.tx.run((tx) => services.media.assertReadableByStaff(tx, other.staff, file.id)),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
      await services.tx.run((tx) =>
        services.media.assertReadableByStaff(tx, requester.staff, file.id),
      );
      const detail = await services.changes.create(
        requester.ctx,
        requester.staff,
        body,
        options(requester, "create", body),
      );
      expect(detail.entity).toBeNull();
      expect(await h.prisma.fileRef.findFirst({ where: { fileId: file.id } })).toMatchObject({
        refType: "account_change_request",
        role: "proof",
        refId: detail.accountChangeRequestId,
        state: "live",
      });
      await services.tx.run((tx) => services.media.assertReadableByStaff(tx, other.staff, file.id));
      await expect(
        services.tx.run((tx) => services.media.assertReadableByStaff(tx, manager.staff, file.id)),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
      const owned = await user(),
        alien = await user(),
        foreignFile = await proof(requester, alien.entity!.id),
        somebody = await proof(other, owned.entity!.id),
        wrongCategory = await h.make.fileObject({
          category: "kyc_license",
          bucket: "secure",
          scopeType: "entity",
          entityId: owned.entity!.id,
          uploadActorType: "staff",
          uploadActorId: requester.staff.staff.id,
          uploadClient: "admin",
        });
      const byEntity = await services.media.register(
        { identity: requester.ctx, staff: requester.staff, audit: requester.meta },
        {
          category: "account_proof",
          entityId: owned.entity!.id,
          files: [{ fileName: "entity-proof.pdf", sizeBytes: "1024", clientToken: uuidv7() }],
        },
      );
      expect(
        await h.prisma.fileObject.findUnique({ where: { id: byEntity.items[0]!.fileId } }),
      ).toMatchObject({
        bucket: "secure",
        scopeType: "entity",
        entityId: owned.entity!.id,
        storeId: null,
      });
      for (const badFile of [foreignFile, somebody, wrongCategory]) {
        const input: AccountChangeCreateBody = {
          ...body,
          merchantUserId: owned.id,
          newPhone: nextPhone(),
          confirm: { targetPhoneMask: owned.row.phoneMask! },
          proofFileIds: [badFile.id],
        };
        const count = await h.prisma.accountChangeRequest.count();
        await expect(
          services.changes.create(
            requester.ctx,
            requester.staff,
            input,
            options(requester, "create", input),
          ),
        ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
        expect(await h.prisma.accountChangeRequest.count()).toBe(count);
      }
    }
  });

  it("驳回跳过stepup、本人撤回和失效发起人代撤均清密文且保留证明", async () => {
    const requester = await actor(),
      stale = await actor("cs", true, true);
    for (const op of ["reject", "withdraw", "proxy"] as const) {
      const who = await user(),
        { detail } = await submit(requester, who, "phone_rebind");
      let result: AccountChangeRequestDetail;
      if (op === "reject") {
        const body = { note: "材料核实未通过", confirm: { requestNo: detail.requestNo } };
        result = await services.changes.reject(
          stale.ctx,
          stale.staff,
          detail.accountChangeRequestId,
          body,
          options(stale, "reject", body, detail.accountChangeRequestId),
        );
      } else {
        if (op === "proxy")
          await h.prisma.staff.update({
            where: { id: requester.staff.staff.id },
            data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
          });
        const by = op === "proxy" ? await actor("super_admin") : requester;
        const body = { note: "撤销申请", confirm: { requestNo: detail.requestNo } };
        result = await services.changes.withdraw(
          by.ctx,
          by.staff,
          detail.accountChangeRequestId,
          body,
          options(by, "withdraw", body, detail.accountChangeRequestId),
        );
      }
      expect(result.approval.status).toBe(op === "reject" ? "rejected" : "withdrawn");
      expect(await persisted(detail)).toMatchObject({ newPhoneEnc: null, appliedAt: null });
      expect(
        await h.prisma.fileRef.findFirst({ where: { refId: detail.accountChangeRequestId } }),
      ).toMatchObject({ state: "live", releasedAt: null });
    }
    expect(await findI26Violations(h.prisma)).toEqual([]);
  });

  it("真实事件依赖失败整笔回滚新老板、迁移、审计与审批，不吞异常", async () => {
    const requester = await actor(),
      decider = await actor("cs", true),
      who = await user(),
      phone = nextPhone();
    const { detail } = await submit(requester, who, "owner_transfer", phone),
      broken = stack(h.prisma, "approval.approved");
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(approve(decider, detail, broken)).rejects.toThrow(
      "lyxtest account apply rollback",
    );
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    expect(
      await h.prisma.merchantUser.findUnique({
        where: { phoneBidx: blindIndex(keyring, "phone", phone) },
      }),
    ).toBeNull();
    expect(await persisted(detail)).toMatchObject({
      appliedAt: null,
      approvalRequest: { status: "pending" },
    });
  });

  it("同单双审批仅一笔生效（独立max1客户端×3轮），新老板与事件不重复", async () => {
    const clients = await Promise.all([openClient(db, { max: 1 }), openClient(db, { max: 1 })]);
    try {
      const stacks = clients.map((client) => stack(client)),
        requester = await actor(),
        deciders = await Promise.all([actor("cs", true), actor("cs", true)]);
      for (let round = 0; round < 3; round++) {
        const who = await user(),
          phone = nextPhone(),
          { detail } = await submit(requester, who, "owner_transfer", phone);
        const results = await Promise.allSettled([
          approve(deciders[0]!, detail, stacks[0]!),
          approve(deciders[1]!, detail, stacks[1]!),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const failed = results.find((result) => result.status === "rejected");
        expect(failed).toMatchObject({
          status: "rejected",
          reason: { error: "APPROVAL_NOT_PENDING" },
        });
        expect(
          await h.prisma.entityMember.count({
            where: { entityId: who.entity!.id, role: "owner", status: "active" },
          }),
        ).toBe(1);
        expect((await persisted(detail)).approvalRequest.status).toBe("approved");
      }
      expect(await findI26Violations(h.prisma)).toEqual([]);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it("证明释放按每实例业务时钟和注销/关闭任一满三年，边界后仅加分类7天", async () => {
    const requester = await actor(),
      who = await user(),
      { detail } = await submit(requester, who, "phone_rebind");
    const body = { confirm: { requestNo: detail.requestNo } };
    await services.changes.withdraw(
      requester.ctx,
      requester.staff,
      detail.accountChangeRequestId,
      body,
      options(requester, "withdraw", body, detail.accountChangeRequestId),
    );
    const closedAt = new Date("2026-02-01T00:00:00.000Z"),
      deletedAt = new Date("2027-02-01T00:00:00.000Z");
    await h.prisma.entity.update({
      where: { id: who.entity!.id },
      data: { lifecycle: "closed", closedAt },
    });
    await h.prisma.merchantUser.update({
      where: { id: who.id },
      data: {
        status: "deleted",
        deletedAt,
        phoneEnc: null,
        phoneBidx: null,
        phoneMask: null,
        phoneLast4: null,
        displayName: null,
      },
    });
    const beforeClock = createClock(new Date("2029-01-31T23:59:59.999Z")),
      atClock = createClock(new Date("2029-02-01T00:00:00.000Z"));
    const tooEarly = stack(h.prisma, undefined, beforeClock),
      mature = stack(h.prisma, undefined, atClock);
    const input = {
      fileId: detail.proofFileIds[0]!,
      refType: "account_change_request",
      refId: detail.accountChangeRequestId,
      role: "proof",
      entityId: who.entity!.id,
      storeId: null,
      keepUntil: atClock.now(),
    };
    await expect(tooEarly.tx.run((tx) => tooEarly.media.release(tx, input))).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    await expect(
      h.tx.run((tx) =>
        assembly.portEntries(fileRefTypePort).get("account_change_request")!.roles.proof!
          .canRelease!(tx, detail.accountChangeRequestId),
      ),
    ).rejects.toThrow("须绑定");
    await mature.tx.run((tx) => mature.media.release(tx, input));
    expect(
      await h.prisma.fileRef.findFirst({ where: { refId: detail.accountChangeRequestId } }),
    ).toMatchObject({
      state: "released",
      releasedAt: atClock.now(),
      keepUntil: new Date(atClock.now().getTime() + 7 * DAY),
    });
    // 另一个实例仍持自己的较早时钟，不能被成熟实例覆盖。
    await expect(tooEarly.tx.run((tx) => tooEarly.media.release(tx, input))).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    await h.prisma.entity.update({ where: { id: who.entity!.id }, data: { closedAt: deletedAt } });
    await h.prisma.merchantUser.update({ where: { id: who.id }, data: { deletedAt: closedAt } });
    await mature.tx.run((tx) => mature.media.release(tx, input));
    expect(
      await h.prisma.fileRef.findFirst({ where: { refId: detail.accountChangeRequestId } }),
    ).toMatchObject({ keepUntil: new Date(atClock.now().getTime() + 7 * DAY) });
  });
});
