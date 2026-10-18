import { InvitationCardSchema, MembershipResultSchema } from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi;
beforeAll(async () => {
  api = await handle.start();
  await seedUserAgreements(handle, api);
}, 180_000);
async function world(targetPhone?: string) {
  const owner = await signInAsMerchant(api),
    user = await signInAsMerchant(api);
  const tenant = merchantServicesOf(api.runtime).tenant;
  const created = await tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const db = await handle.db.prisma(),
    make = createFactories({ db, clock: api.clock });
  const response = await api.request("/api/v1/m/invitations", {
    method: "POST",
    headers: owner.withStore(created.storeId),
    json: { clientRequestId: uuidv7(), ...(targetPhone ? { targetPhone } : {}) },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return { owner, user, tenant, db, make, card: InvitationCardSchema.parse(body.data), ...created };
}
async function accept(
  w: Awaited<ReturnType<typeof world>>,
  options: {
    headers?: Record<string, string>;
    key?: string | null;
    body?: unknown;
    id?: string;
  } = {},
) {
  const response = await api.request(
    `/api/v1/m/invitations/${options.id ?? w.card.invitationId}/accept`,
    {
      method: "POST",
      headers: {
        ...(options.headers ?? w.user.headers),
        ...(options.key === null ? {} : { "Idempotency-Key": options.key ?? uuidv7() }),
      },
      json: options.body ?? { token: w.card.token, displayName: "公开店员" },
    },
  );
  return {
    response,
    body: (await response.json()) as { data?: unknown; error?: string; details?: unknown },
  };
}
async function business(w: Awaited<ReturnType<typeof world>>) {
  const where = { entityId: w.entityId };
  return {
    invitations: await w.db.invitation.findMany({ where, orderBy: { id: "asc" } }),
    members: await w.db.entityMember.findMany({ where, orderBy: { id: "asc" } }),
    stores: await w.db.storeMember.findMany({
      where,
      orderBy: [{ entityMemberId: "asc" }, { storeId: "asc" }],
    }),
    timers: await w.db.timer.findMany({ where, orderBy: { id: "asc" } }),
    history: await w.db.statusTransition.findMany({ where, orderBy: { seq: "asc" } }),
    events: await w.db.outboxEvent.findMany({ where, orderBy: { seq: "asc" } }),
    audits: await w.db.auditLog.findMany({ where, orderBy: { seq: "asc" } }),
  };
}

describe("接受邀请真实 HTTP 与当前会话", { timeout: 120_000 }, () => {
  it("无 X-Store 首次接受落真实成员/邀请/定时器，使用当前会话 Openid且不重复写同意", async () => {
    const w = await world(),
      checks = api.wechat.callsOf("checkText").length;
    const consents = await w.db.agreementConsent.findMany({
      where: { merchantUserId: w.user.merchantUserId },
    });
    const result = await accept(w);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    const data = MembershipResultSchema.parse(result.body.data);
    expect(data).toMatchObject({
      entityId: w.entityId,
      storeId: w.storeId,
      role: "clerk",
      isNew: true,
      abandonedEntityId: null,
    });
    expect(Object.keys(data)).toHaveLength(6);
    expect(
      await w.db.invitation.findUniqueOrThrow({ where: { id: w.card.invitationId } }),
    ).toMatchObject({
      status: "accepted",
      acceptedByUserId: w.user.merchantUserId,
      acceptedMemberId: data.memberId,
      tokenEnc: null,
    });
    expect(
      await w.db.timer.findFirstOrThrow({ where: { subjectId: w.card.invitationId } }),
    ).toMatchObject({ status: "cancelled" });
    expect(
      api.wechat
        .callsOf("checkText")
        .slice(checks)
        .map((call) => call.input),
    ).toEqual([{ openid: w.user.openid, scene: "profile", content: "公开店员" }]);
    expect(
      await w.db.agreementConsent.findMany({ where: { merchantUserId: w.user.merchantUserId } }),
    ).toEqual(consents);
    expect(
      (await w.db.merchantUser.findUniqueOrThrow({ where: { id: w.user.merchantUserId } }))
        .displayName,
    ).toBe("公开店员");
  });
  it("同键与新键重放均当前投影且零业务旁写，不重新外检；另一受邀人不能重放", async () => {
    const w = await world(),
      key = uuidv7(),
      first = await accept(w, { key });
    expect(first.response.status).toBe(200);
    const snapshot = await business(w),
      calls = api.wechat.callsOf("checkText").length;
    expect((await accept(w, { key })).body.data).toEqual(first.body.data);
    expect((await accept(w)).body.data).toMatchObject({
      ...MembershipResultSchema.parse(first.body.data),
      isNew: false,
    });
    expect(await business(w)).toEqual(snapshot);
    expect(api.wechat.callsOf("checkText")).toHaveLength(calls);
    const stranger = await signInAsMerchant(api);
    const used = await accept(w, { headers: stranger.headers });
    expect([used.response.status, used.body.error]).toEqual([410, "INVITATION_USED"]);
    expect(await business(w)).toEqual(snapshot);
  });
  it.each(["removed", "archived"] as const)("本人已%s的同键不返回缓存身份", async (mode) => {
    const w = await world(),
      key = uuidv7(),
      first = await accept(w, { key });
    expect(first.response.status).toBe(200);
    const member = MembershipResultSchema.parse(first.body.data);
    if (mode === "removed")
      await w.tenant.removeMember(
        createIdentityContext({
          actor: { type: "merchant", id: w.owner.merchantUserId, client: "weapp" },
          entityId: w.entityId,
          storeId: w.storeId,
        }),
        { memberId: member.memberId },
      );
    else
      await w.db.store.update({
        where: { id: w.storeId },
        data: {
          lifecycle: "archived",
          archivedAt: api.clock.now(),
          archiveActorType: "merchant",
          archiveActorId: w.owner.merchantUserId,
          archiveClient: "weapp",
          archiveReason: "by_owner",
        },
      });
    const snapshot = await business(w),
      result = await accept(w, { key });
    expect([result.response.status, result.body.error]).toEqual([
      403,
      mode === "removed" ? "NOT_A_MEMBER" : "STORE_ARCHIVED",
    ]);
    expect(await business(w)).toEqual(snapshot);
  });
  it.each(["block", "unavailable", "throw"] as const)(
    "称呼外检%s明确拒收且零业务写",
    async (mode) => {
      const w = await world(),
        snapshot = await business(w);
      const fail =
        mode === "throw"
          ? vi
              .spyOn(api.runtime.providers.wechat, "checkText")
              .mockRejectedValueOnce(new Error("公开故障"))
          : undefined;
      if (mode === "block") api.wechat.textVerdicts.push("block");
      if (mode === "unavailable") api.wechat.setTextCheckAvailable(false);
      try {
        const result = await accept(w);
        expect([result.response.status, result.body.error]).toEqual(
          mode === "block" ? [400, "CONTENT_REJECTED"] : [503, "PROVIDER_UNAVAILABLE"],
        );
        if (mode === "block") expect(result.body.details).toEqual({ fields: ["displayName"] });
        expect(await business(w)).toEqual(snapshot);
      } finally {
        fail?.mockRestore();
        api.wechat.setTextCheckAvailable(true);
      }
    },
  );
  it("严格正文、路径、令牌、缺幂等键与 Unicode 边界均保守拒绝", async () => {
    const w = await world(),
      snapshot = await business(w);
    for (const options of [
      { key: null },
      { id: "bad" },
      { body: { token: w.card.token, consents: [] } },
      { body: { token: w.card.token, displayName: "🍜".repeat(21) } },
      { body: { token: w.card.token, displayName: " " } },
      { body: { token: w.card.token + "\n" } },
    ]) {
      const result = await accept(w, options);
      expect(result.response.status).toBe(400);
    }
    const invalid = await accept(w, { body: { token: "z".repeat(43), displayName: "有效" } });
    expect([invalid.response.status, invalid.body.error]).toEqual([404, "INVITATION_INVALID"]);
    expect(await business(w)).toEqual(snapshot);
    const valid = await accept(w, { body: { token: w.card.token, displayName: "🍜".repeat(20) } });
    expect(valid.response.status).toBe(200);
  });
  it("无称呼账号必须提供称呼；既有账号可省略且不覆盖其账号称呼", async () => {
    const w = await world();
    const missing = await accept(w, { body: { token: w.card.token } });
    expect([missing.response.status, missing.body.error]).toEqual([400, "VALIDATION_FAILED"]);
    await w.db.merchantUser.update({
      where: { id: w.user.merchantUserId },
      data: { displayName: "既有称呼" },
    });
    const calls = api.wechat.callsOf("checkText").length;
    expect((await accept(w, { body: { token: w.card.token } })).response.status).toBe(200);
    expect(api.wechat.callsOf("checkText")).toHaveLength(calls);
    expect(
      (await w.db.merchantUser.findUniqueOrThrow({ where: { id: w.user.merchantUserId } }))
        .displayName,
    ).toBe("既有称呼");
  });
  it("定向号码、elapsed pending与未登录明确失败，邀请不被修改", async () => {
    const w = await world("13800138000"),
      snapshot = await business(w);
    const wrong = await accept(w);
    expect([wrong.response.status, wrong.body.error]).toEqual([403, "INVITATION_NOT_FOR_YOU"]);
    const guest = await accept(w, { headers: {} });
    expect([guest.response.status, guest.body.error]).toEqual([401, "AUTH_REQUIRED"]);
    const saved = api.clock.now();
    try {
      api.clock.set(new Date(w.card.expiresAt));
      const elapsed = await accept(w);
      expect([elapsed.response.status, elapsed.body.error]).toEqual([410, "INVITATION_EXPIRED"]);
      expect(await business(w)).toEqual(snapshot);
    } finally {
      api.clock.set(saved);
    }
  });
  it("目标老板不能接受自己的 pending 卡；同主体店员可不带 X-Store追加", async () => {
    const w = await world(),
      self = await accept(w, { headers: w.owner.headers });
    expect([self.response.status, self.body.error]).toEqual([409, "ALREADY_OWNER"]);
    const other = await w.make.store({ entityId: w.entityId });
    const member = await w.make.entityMember({
      entityId: w.entityId,
      merchantUserId: w.user.merchantUserId,
      invitedByMemberId: w.memberId,
      lastStoreId: other.id,
    });
    await w.make.storeMember({
      entityMemberId: member.id,
      storeId: other.id,
      addedByMemberId: w.memberId,
    });
    const result = await accept(w);
    expect(result.response.status).toBe(200);
    expect(result.body.data).toMatchObject({ memberId: member.id, isNew: false, role: "clerk" });
    const event = await w.db.outboxEvent.findFirstOrThrow({
      where: { aggregateId: member.id, eventType: "entity_member.stores_changed" },
    });
    expect(event.payload).toMatchObject({
      invitationId: w.card.invitationId,
      addedStoreIds: [w.storeId],
      removedStoreIds: [],
    });
  });
  it("新增协议版本先由原中间件428，补同意后原键接受且不再次写同意", async () => {
    const w = await world(),
      key = uuidv7();
    const version = await w.make.agreementVersion({ agreementKey: "privacy", status: "pending" });
    merchantServicesOf(api.runtime).identity.consentGate.invalidate();
    const denied = await accept(w, { key });
    expect([denied.response.status, denied.body.error]).toEqual([428, "CONSENT_REQUIRED"]);
    expect(
      (await w.db.invitation.findUniqueOrThrow({ where: { id: w.card.invitationId } })).status,
    ).toBe("pending");
    const consent = await api.request("/api/v1/m/agreement-consents", {
      method: "POST",
      headers: w.user.headers,
      json: { consents: [{ agreementKey: "privacy", agreementVersionId: version.id }] },
    });
    expect(consent.status).toBe(200);
    const before = await w.db.agreementConsent.count({
      where: { merchantUserId: w.user.merchantUserId },
    });
    const result = await accept(w, { key });
    expect(result.response.status).toBe(200);
    expect(
      await w.db.agreementConsent.count({ where: { merchantUserId: w.user.merchantUserId } }),
    ).toBe(before);
  });
});
