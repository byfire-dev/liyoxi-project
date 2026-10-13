import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApproval } from "../approval/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdempotencyContext,
  createTxRunner,
  uuidv7,
} from "../kernel/index.js";
import { createNotifyDispatcher } from "../notify/index.js";
import { blindIndex, encryptField } from "../security/index.js";
import {
  assembleForTest,
  notificationFixture,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import {
  buildHarness,
  keyring,
  META,
  nextOpenid,
  nextPhone,
  openClient,
  TEST_APPID,
} from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { createIdentity } from "./service.js";
import type { Identity } from "./service.js";
import type { SessionPrincipal } from "./types.js";

const db = useSeededDatabase("services", { label: "phonechange", max: 1 });
let h: Harness, identity: Identity, notify: ReturnType<typeof createNotifyDispatcher>;
const assembly = assembleForTest({ entry: "api" });
let configured = true;
function stack(client = h.prisma, failPhoneEvent = false) {
  const tx = createTxRunner({ prisma: client, appEnv: "test" });
  const events = createEvents({ tx, clock: h.clock, assembly });
  if (failPhoneEvent) {
    const real = events.emit;
    vi.spyOn(events, "emit").mockImplementation(async (...args) => {
      const result = await real(...args);
      if (args[2].type === "merchant_user.phone_changed") throw new Error("lyxtest phone rollback");
      return result;
    });
  }
  const flow = createFlow({ clock: h.clock, assembly, events });
  const approval = createApproval({
    clock: h.clock,
    assembly,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  return createIdentity({
    tx,
    clock: h.clock,
    assembly,
    events,
    flow,
    approval,
    docs: h.docs,
    tenant: h.tenant,
    config: {
      params: { get: async () => 180 },
      flags: { minClientVersion: async () => "0.0.0" },
    } as never,
    keyring: () => keyring,
    wechat: h.wechat,
    appid: TEST_APPID,
    smsConfigured: () => configured,
    notify,
  });
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
  identity = stack();
  await h.prisma.smsTemplate.updateMany({
    where: { templateKey: { in: ["verify_code", "account_notice"] } },
    data: {
      status: "active",
      providerTemplateId: "fictional-template",
      signName: "虚构公司",
      updatedAt: h.clock.now(),
    },
  });
}, 120_000);
afterAll(async () => {
  await notify?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  configured = true;
});
async function user() {
  const phone = nextPhone();
  const login = await h.identity.phoneLogin(META, {
    ...h.codes({ phone, openid: nextOpenid() }),
    consents: h.consents(),
  });
  const auth = await h.identity.authenticate(login.token, { ip: META.ip });
  if (!auth.ok) throw new Error("登录没有形成会话");
  return { phone, token: login.token, principal: auth.principal };
}
const smsCalls = () => h.providers.providers.sms.callsOf("sendSubscribeFallback");
function idem(principal: SessionPrincipal, scope: string, body: unknown, key = uuidv7()) {
  return {
    idem: createIdempotencyContext({
      mode: "required",
      scope,
      key,
      actor: { type: "merchant", id: principal.merchantUserId, client: "weapp", role: null },
      request: { method: "POST", pathParams: {}, body, storeId: null },
    }),
  };
}
async function code(who: Awaited<ReturnType<typeof user>>) {
  await identity.createSmsCode(
    who.principal,
    META,
    { purpose: "phone_change" },
    idem(who.principal, "m.smsCode.create", { purpose: "phone_change" }),
  );
  const call = smsCalls()
    .filter((row) => (row.input as { phone: string }).phone === who.phone)
    .at(-1)!;
  return (call.input as { params: { code: string } }).params.code;
}
function body(code: string, phone = nextPhone()) {
  const newPhoneCode = `new-phone-${uuidv7()}`;
  h.wechat.phones.set(newPhoneCode, phone);
  return { input: { oldSmsCode: code, newPhoneCode }, phone };
}
async function change(
  who: Awaited<ReturnType<typeof user>>,
  input: ReturnType<typeof body>["input"],
  key = uuidv7(),
) {
  return identity.changePhone(
    who.principal,
    META,
    input,
    idem(who.principal, "m.me.changePhone", input, key),
  );
}
const latest = (id: string) =>
  h.prisma.smsVerification.findFirstOrThrow({
    where: { merchantUserId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
async function portalFor(userId: string) {
  const entity = await h.make.entity({ createdByUserId: userId }),
    store = await h.make.store({ entityId: entity.id });
  return h.prisma.portalSession.create({
    data: {
      id: uuidv7(),
      portalTicketId: uuidv7(),
      approvedByUserId: userId,
      entityId: entity.id,
      storeId: store.id,
      grantScope: "store",
      tokenHash: Buffer.from(uuidv7().replaceAll("-", "")),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
      expiresAt: new Date(h.clock.now().getTime() + 7200000),
      ip: META.ip!,
      userAgent: META.userAgent!,
    },
  });
}

describe("手机号验证码与换绑的真实事务边界", { timeout: 120_000 }, () => {
  it("发码只存哈希、5分钟有效；同键重放不外呼，号码预算拒绝并删除新行保留前码", async () => {
    const who = await user(),
      input = { purpose: "phone_change" as const },
      key = uuidv7();
    const result = await identity.createSmsCode(
      who.principal,
      META,
      input,
      idem(who.principal, "m.smsCode.create", input, key),
    );
    const first = await latest(who.principal.merchantUserId),
      calls = smsCalls().length;
    expect(result).toMatchObject({
      targetPhoneMask: `138****${who.phone.slice(-4)}`,
      resendAfterSec: 60,
    });
    expect(new Date(result.expiresAt).getTime() - h.clock.now().getTime()).toBe(300_000);
    expect(first.codeHash).toHaveLength(32);
    expect(
      await identity.createSmsCode(
        who.principal,
        META,
        input,
        idem(who.principal, "m.smsCode.create", input, key),
      ),
    ).toEqual(result);
    expect(smsCalls()).toHaveLength(calls);
    await expect(
      identity.createSmsCode(
        who.principal,
        META,
        input,
        idem(who.principal, "m.smsCode.create", input),
      ),
    ).rejects.toMatchObject({ error: "RATE_LIMITED" });
    expect(await latest(who.principal.merchantUserId)).toEqual(first);
    expect(
      await h.prisma.smsVerification.count({
        where: { merchantUserId: who.principal.merchantUserId },
      }),
    ).toBe(1);
  });
  it("未配置/真实投递失败不残留验证码；同键补偿后可重试，不写明文审计或事件", async () => {
    const who = await user(),
      input = { purpose: "phone_change" as const },
      key = uuidv7();
    configured = false;
    await expect(
      identity.createSmsCode(
        who.principal,
        META,
        input,
        idem(who.principal, "m.smsCode.create", input, key),
      ),
    ).rejects.toMatchObject({ error: "SMS_UNAVAILABLE" });
    configured = true;
    const send = notify.sendDirect;
    vi.spyOn(notify, "sendDirect").mockRejectedValueOnce(
      new (await import("../kernel/index.js")).AppError("NOT_FOUND"),
    );
    await expect(
      identity.createSmsCode(
        who.principal,
        META,
        input,
        idem(who.principal, "m.smsCode.create", input, key),
      ),
    ).rejects.toMatchObject({ error: "SMS_UNAVAILABLE" });
    vi.restoreAllMocks();
    expect(notify.sendDirect).toBe(send);
    h.providers.providers.sms.failNext("sendSubscribeFallback");
    await expect(
      identity.createSmsCode(
        who.principal,
        META,
        input,
        idem(who.principal, "m.smsCode.create", input, key),
      ),
    ).rejects.toMatchObject({ error: "SMS_UNAVAILABLE" });
    expect(
      await h.prisma.smsVerification.count({
        where: { merchantUserId: who.principal.merchantUserId },
      }),
    ).toBe(0);
    h.clock.advance(60_000);
    expect(
      await identity.createSmsCode(
        who.principal,
        META,
        input,
        idem(who.principal, "m.smsCode.create", input, key),
      ),
    ).toMatchObject({ purpose: "phone_change" });
  });
  it("成功一次核销，保留当前token与portal；其他设备吊销，旧号码只用于事务外直发，重放不重复取号/通知", async () => {
    const who = await user(),
      other = await h.identity.phoneLogin(META, {
        ...h.codes({ phone: who.phone, openid: nextOpenid() }),
        consents: h.consents(),
      });
    const portal = await portalFor(who.principal.merchantUserId);
    const request = body(await code(who)),
      key = uuidv7();
    const current = await h.prisma.userSession.findUniqueOrThrow({
      where: { id: who.principal.sessionId },
    });
    const first = await change(who, request.input, key);
    const providerCalls = h.wechat.callsOf("getPhoneNumber").length,
      directCalls = smsCalls().length;
    expect(first.phoneMask).toBe(`138****${request.phone.slice(-4)}`);
    expect((await latest(who.principal.merchantUserId)).usedAt).not.toBeNull();
    expect(
      await h.prisma.userSession.findUniqueOrThrow({ where: { id: who.principal.sessionId } }),
    ).toEqual(current);
    expect(await h.identity.authenticate(who.token, { ip: META.ip })).toMatchObject({ ok: true });
    expect(await h.identity.authenticate(other.token, { ip: META.ip })).toMatchObject({
      ok: false,
    });
    expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: portal.id } })).toEqual(
      portal,
    );
    const notice = smsCalls().at(-1)!.input as { phone: string; templateKey: string };
    expect(notice).toMatchObject({ phone: who.phone, templateKey: "account_notice" });
    h.wechat.phones.delete(request.input.newPhoneCode);
    expect(await change(who, request.input, key)).toEqual(first);
    expect(h.wechat.callsOf("getPhoneNumber")).toHaveLength(providerCalls);
    expect(smsCalls()).toHaveLength(directCalls);
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: who.principal.merchantUserId,
        eventType: "merchant_user.phone_changed",
      },
    });
    expect(event.payload).toEqual({
      v: 1,
      merchantUserId: who.principal.merchantUserId,
      via: "self_service",
    });
    const audit = await h.prisma.auditLog.findFirstOrThrow({
      where: {
        targetId: who.principal.merchantUserId,
        action: "identity.merchant_user.change_phone",
      },
    });
    expect(JSON.stringify(audit)).not.toContain(who.phone);
    expect(JSON.stringify(audit)).not.toContain(request.phone);
  });
  it("错码五次独立提交；作废/过期/旧于最新码不取新手机号，不跨账号核销", async () => {
    const who = await user(),
      correct = await code(who),
      wrong = correct === "000000" ? "111111" : "000000";
    const request = body(wrong),
      calls = h.wechat.callsOf("getPhoneNumber").length;
    for (let i = 1; i <= 5; i++) {
      await expect(change(who, request.input)).rejects.toMatchObject({
        error: "SMS_CODE_INVALID",
        details: { attemptsLeft: 5 - i },
      });
      expect((await latest(who.principal.merchantUserId)).attempts).toBe(i);
    }
    await expect(change(who, body(correct).input)).rejects.toMatchObject({
      error: "SMS_CODE_INVALID",
      details: { attemptsLeft: null },
    });
    expect(h.wechat.callsOf("getPhoneNumber")).toHaveLength(calls);
    const stranger = await user();
    await expect(change(stranger, body(correct).input)).rejects.toMatchObject({
      error: "SMS_CODE_INVALID",
    });
    const expired = await user();
    await code(expired);
    h.clock.advance(300_000);
    await expect(change(expired, body("000000").input)).rejects.toMatchObject({
      error: "SMS_CODE_INVALID",
      details: { attemptsLeft: null },
    });
    const refreshed = await user(),
      old = await code(refreshed);
    h.clock.advance(60_000);
    await code(refreshed);
    await expect(change(refreshed, body(old).input)).rejects.toMatchObject({
      error: "SMS_CODE_INVALID",
    });
  });
  it("微信失败/境外/不变/占用账号有历史或禁用均不核销旧码、不改账号/会话", async () => {
    const who = await user(),
      oldSmsCode = await code(who);
    const occupied = await user();
    await h.prisma.merchantUser.update({
      where: { id: occupied.principal.merchantUserId },
      data: { status: "disabled" },
    });
    const history = await user();
    const entity = await h.make.entity({ createdByUserId: history.principal.merchantUserId });
    await h.make.entityMember({
      merchantUserId: history.principal.merchantUserId,
      entityId: entity.id,
      status: "removed",
      removedAt: h.clock.now(),
      removeReason: "self",
      displayName: null,
    });
    const before = await snapshotTables(h.prisma, [
      "merchant_user",
      "user_session",
      "sms_verification",
    ]);
    for (const [phone, error] of [
      ["+1 312 555 0199", "PHONE_REGION_UNSUPPORTED"],
      [who.phone, "PHONE_UNCHANGED"],
      [occupied.phone, "PHONE_TAKEN"],
      [history.phone, "PHONE_TAKEN"],
    ])
      await expect(change(who, body(oldSmsCode, phone).input)).rejects.toMatchObject({ error });
    h.wechat.failNext("getPhoneNumber");
    await expect(change(who, body(oldSmsCode).input)).rejects.toMatchObject({
      error: "WECHAT_UNAVAILABLE",
    });
    await expect(change(who, { oldSmsCode, newPhoneCode: "missing-code" })).rejects.toMatchObject({
      error: "WECHAT_CODE_INVALID",
    });
    expect(
      await snapshotTables(h.prisma, ["merchant_user", "user_session", "sms_verification"]),
    ).toEqual(before);
  });
  it("空占用账号同Tx清全部个人依附并system代撤申请，历史审计保留；随后事件失败整笔回滚", async () => {
    const who = await user(),
      empty = await user();
    const portal = await portalFor(empty.principal.merchantUserId);
    const wi = await h.prisma.wechatIdentity.findFirstOrThrow({
      where: { merchantUserId: empty.principal.merchantUserId },
    });
    await h.prisma.wxSubscribeQuota.create({
      data: {
        wechatIdentityId: wi.id,
        wxTemplateSlotKey: "member_change",
        merchantUserId: empty.principal.merchantUserId,
        estRemaining: 1,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.prisma.merchantUserNotice.create({
      data: {
        id: uuidv7(),
        merchantUserId: empty.principal.merchantUserId,
        kind: "new_wechat_bound",
        occurredAt: h.clock.now(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await code(empty);
    const staff = await h.make.staff({ staffRoleKey: "cs" });
    await h.prisma.wecomContact.create({
      data: {
        id: uuidv7(),
        staffId: staff.id,
        merchantUserId: empty.principal.merchantUserId,
        externalUseridEnc: encryptField(
          keyring,
          "wecom_contact.external_userid_enc",
          "fictional-contact",
        ),
        externalUseridBidx: Buffer.alloc(32, 5),
        addedAt: h.clock.now(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const approval = await h.prisma.approvalRequest.create({
      data: {
        id: uuidv7(),
        kind: "account_change",
        category: "approval",
        requestNo: `ZH${uuidv7().replaceAll("-", "").slice(-12)}`,
        subjectType: "merchant_user",
        subjectId: empty.principal.merchantUserId,
        status: "pending",
        summarySnapshot: { title: "换绑核实" },
        submitActorType: "staff",
        submitActorId: staff.id,
        submitClient: "admin",
        requesterStaffId: staff.id,
        submittedAt: h.clock.now(),
        dedupeKey: `account_change:${empty.principal.merchantUserId}`,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const request = await h.prisma.accountChangeRequest.create({
      data: {
        id: uuidv7(),
        approvalRequestId: approval.id,
        kind: "phone_rebind",
        merchantUserId: empty.principal.merchantUserId,
        newPhoneEnc: encryptField(keyring, "account_change_request.new_phone_enc", nextPhone()),
        newPhoneMask: "138****0001",
        proofFileIds: [uuidv7()],
        reasonCode: "other",
        reasonText: "虚构核实",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const input = body(await code(who), empty.phone).input;
    const tables = [
      "merchant_user",
      "user_session",
      "portal_session",
      "wechat_identity",
      "wx_subscribe_quota",
      "sms_verification",
      "merchant_user_notice",
      "wecom_contact",
      "account_change_request",
      "approval_request",
      "audit_log",
      "outbox_event",
      "status_transition",
    ];
    const before = await snapshotTables(h.prisma, tables);
    await expect(
      stack(h.prisma, true).changePhone(
        who.principal,
        META,
        input,
        idem(who.principal, "m.me.changePhone", input),
      ),
    ).rejects.toThrow("lyxtest phone rollback");
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    await change(who, body(input.oldSmsCode, empty.phone).input);
    expect(
      await h.prisma.merchantUser.findUniqueOrThrow({
        where: { id: empty.principal.merchantUserId },
      }),
    ).toMatchObject({ status: "deleted", phoneEnc: null, displayName: null });
    expect(await h.prisma.portalSession.findUnique({ where: { id: portal.id } })).toBeNull();
    expect(
      await h.prisma.wxSubscribeQuota.count({
        where: { merchantUserId: empty.principal.merchantUserId },
      }),
    ).toBe(0);
    expect(
      await h.prisma.wecomContact.count({
        where: { merchantUserId: empty.principal.merchantUserId },
      }),
    ).toBe(0);
    for (const table of [
      h.prisma.userSession,
      h.prisma.wechatIdentity,
      h.prisma.smsVerification,
      h.prisma.merchantUserNotice,
    ])
      expect(
        await (table as typeof h.prisma.userSession).count({
          where: { merchantUserId: empty.principal.merchantUserId },
        }),
      ).toBe(0);
    expect(
      await h.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({ status: "withdrawn", isDecidedBySystem: true });
    expect(
      await h.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).toMatchObject({ newPhoneEnc: null });
    expect(
      await h.prisma.statusTransition.count({
        where: {
          machine: "merchant_user",
          subjectId: empty.principal.merchantUserId,
          event: "merchant_user.purge_empty",
        },
      }),
    ).toBe(1);
  });
  it("旧号通知失败仍成功；微信外呼期间会话被撤销时旧码与手机号均回滚", async () => {
    const who = await user(),
      input = body(await code(who)).input;
    h.providers.providers.sms.failNext("sendSubscribeFallback");
    expect(await change(who, input)).toMatchObject({
      merchantUserId: who.principal.merchantUserId,
    });
    const next = await user(),
      row = await h.prisma.merchantUser.findUniqueOrThrow({
        where: { id: next.principal.merchantUserId },
      }),
      nextInput = body(await code(next)).input;
    const real = h.wechat.getPhoneNumber.bind(h.wechat);
    vi.spyOn(h.wechat, "getPhoneNumber").mockImplementationOnce(async (value) => {
      const result = await real(value);
      await h.prisma.userSession.update({
        where: { id: next.principal.sessionId },
        data: { revokedAt: h.clock.now(), revokeReason: "logout" },
      });
      return result;
    });
    await expect(change(next, nextInput)).rejects.toMatchObject({ error: "SESSION_INVALID" });
    expect(await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect((await latest(row.id)).usedAt).toBeNull();
  });
  it("2个max1客户端竞争同一码3轮，恰一笔改绑/核销/事件，另一笔被当前事实拒绝", async () => {
    const clients = await Promise.all([openClient(db, { max: 1 }), openClient(db, { max: 1 })]);
    try {
      const services = clients.map((client) => stack(client));
      for (let round = 0; round < 3; round++) {
        const who = await user(),
          old = await code(who),
          first = body(old),
          second = body(old);
        const results = await Promise.allSettled(
          services.map((service, i) => {
            const input = i ? second.input : first.input;
            return service.changePhone(
              who.principal,
              META,
              input,
              idem(who.principal, "m.me.changePhone", input),
            );
          }),
        );
        expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((row) => row.status === "rejected").map((row) => row.reason)).toEqual(
          [expect.objectContaining({ error: "SMS_CODE_INVALID" })],
        );
        expect(
          await h.prisma.outboxEvent.count({
            where: {
              aggregateId: who.principal.merchantUserId,
              eventType: "merchant_user.phone_changed",
            },
          }),
        ).toBe(1);
        expect((await latest(who.principal.merchantUserId)).usedAt).not.toBeNull();
      }
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });
});
