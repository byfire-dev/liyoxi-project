import {
  InvitationCardSchema,
  InvitationMarkSharedResultSchema,
  InvitationPreviewSchema,
  InvitationRevokeResultSchema,
} from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi;
const paths = {
  "m.invitation.create": "/api/v1/m/invitations",
  "m.invitation.markShared": "/api/v1/m/invitations/{invitationId}/mark-shared",
  "m.invitation.revoke": "/api/v1/m/invitations/{invitationId}/revoke",
  "m.invitation.lookup": "/api/v1/m/invitations/lookup",
};
beforeAll(async () => {
  api = await handle.start();
  await seedUserAgreements(handle, api);
}, 180_000);

async function world() {
  const owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const db = await handle.db.prisma();
  const make = createFactories({ db, clock: api.clock });
  const clerk = await signInAsMerchant(api);
  // 邀请接受尚未交付；此处明确构造已有合法店员关系，不冒称执行接受入口。
  const member = await make.entityMember({
    entityId: created.entityId,
    merchantUserId: clerk.merchantUserId,
    invitedByMemberId: created.memberId,
    lastStoreId: created.storeId,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: created.storeId,
    addedByMemberId: created.memberId,
  });
  const second = await make.store({ entityId: created.entityId });
  return { ...created, owner, clerk, db, make, second };
}
async function post(
  operation: Exclude<keyof typeof paths, "m.invitation.lookup">,
  headers: Record<string, string>,
  json?: unknown,
  invitationId = "",
  key?: string,
) {
  const response = await api.request(paths[operation].replace("{invitationId}", invitationId), {
    method: "POST",
    headers: { ...headers, ...(key === undefined ? {} : { "Idempotency-Key": key }) },
    ...(json === undefined ? {} : { json }),
  });
  return { response, body: (await response.json()) as { data?: unknown; error?: string } };
}
async function lookup(token: string, headers: Record<string, string> = {}) {
  const response = await api.request(
    `${paths["m.invitation.lookup"]}?token=${encodeURIComponent(token)}`,
    { headers },
  );
  return { response, body: (await response.json()) as { data?: unknown; error?: string } };
}
async function trace(w: Awaited<ReturnType<typeof world>>) {
  const where = { entityId: w.entityId };
  return {
    invitations: await w.db.invitation.findMany({ where, orderBy: { id: "asc" } }),
    bindings: await w.db.invitationRequest.findMany({ where, orderBy: { id: "asc" } }),
    timers: await w.db.timer.findMany({ where, orderBy: { id: "asc" } }),
    audits: await w.db.auditLog.findMany({ where, orderBy: { id: "asc" } }),
    events: await w.db.outboxEvent.findMany({ where, orderBy: { id: "asc" } }),
    history: await w.db.statusTransition.findMany({ where, orderBy: { id: "asc" } }),
    idem: await w.db.idempotencyRecord.findMany({
      where: { actorKey: `merchant:${w.owner.merchantUserId}` },
      orderBy: [{ scope: "asc" }, { key: "asc" }],
    }),
  };
}

describe("邀请卡片四个真实 HTTP 入口", { timeout: 120_000 }, () => {
  it("自然 A/B 复用原卡；分享后 B 重放零写，C 新建另一张卡", async () => {
    const w = await world(),
      headers = w.owner.withStore(w.storeId),
      a = uuidv7(),
      b = uuidv7();
    const checks = api.wechat.callsOf("checkText").length;
    const first = await post("m.invitation.create", headers, {
      clientRequestId: a,
      targetPhone: "13800138000",
    });
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get("cache-control")).toBe("no-store");
    const original = InvitationCardSchema.parse(first.body.data);
    expect(Object.keys(original)).toHaveLength(11);
    expect(original).toMatchObject({
      isReused: false,
      role: "clerk",
      isPhoneRestricted: true,
      remarkName: null,
    });
    const savedClock = api.clock.now();
    try {
      api.clock.advance(1_000);
      const reuse = await post("m.invitation.create", headers, { clientRequestId: b });
      expect(reuse.response.status).toBe(200);
      const card = InvitationCardSchema.parse(reuse.body.data);
      expect(card).toMatchObject({
        invitationId: original.invitationId,
        token: original.token,
        isReused: true,
        isPhoneRestricted: true,
      });
      expect(new Date(card.expiresAt).getTime()).toBe(
        new Date(original.expiresAt).getTime() + 1_000,
      );
      const rows = await trace(w);
      expect(rows.invitations).toHaveLength(1);
      expect(rows.bindings.map((row) => row.clientRequestId).sort()).toEqual([a, b].sort());
      expect(rows.timers.filter((row) => row.kind === "invitation.expire")).toHaveLength(1);
      const sharedKey = uuidv7();
      const shared = await post(
        "m.invitation.markShared",
        headers,
        undefined,
        card.invitationId,
        sharedKey,
      );
      expect(shared.response.status).toBe(200);
      const sharedData = InvitationMarkSharedResultSchema.parse(shared.body.data);
      expect(sharedData).toEqual({
        invitationId: card.invitationId,
        sharedAt: api.clock.now().toISOString(),
      });
      const afterShare = await trace(w);
      const replay = await post("m.invitation.create", headers, {
        clientRequestId: b,
        targetPhone: null,
      });
      expect(replay.response.status).toBe(200);
      expect(replay.body.data).toEqual({
        ...card,
        seats: { ...card.seats, includesUnsharedDraft: false },
      });
      const sharedReplay = await post(
        "m.invitation.markShared",
        headers,
        undefined,
        card.invitationId,
        sharedKey,
      );
      expect(sharedReplay.response.status).toBe(200);
      expect(sharedReplay.body.data).toEqual(sharedData);
      expect(await trace(w)).toEqual(afterShare);
      const next = await post("m.invitation.create", headers, { clientRequestId: uuidv7() });
      expect(next.response.status).toBe(200);
      const fresh = InvitationCardSchema.parse(next.body.data);
      expect(fresh.invitationId).not.toBe(card.invitationId);
      expect(fresh.token).not.toBe(card.token);
      expect(fresh.isReused).toBe(false);
      expect((await trace(w)).invitations).toHaveLength(2);
      expect(api.wechat.callsOf("checkText")).toHaveLength(checks);
    } finally {
      api.clock.set(savedClock);
    }
  });

  it("真实当前会话 openid 用于备注外检，绑定重放不重新检测或改正文", async () => {
    const w = await world(),
      headers = w.owner.withStore(w.storeId),
      clientRequestId = uuidv7();
    const before = api.wechat.callsOf("checkText").length;
    const created = await post("m.invitation.create", headers, {
      clientRequestId,
      remarkName: "公开备注",
    });
    expect(created.response.status).toBe(200);
    const card = InvitationCardSchema.parse(created.body.data);
    expect(card.remarkName).toBe("公开备注");
    expect(api.wechat.callsOf("checkText").slice(before)).toHaveLength(1);
    expect(api.wechat.callsOf("checkText").at(-1)!.input).toEqual({
      openid: w.owner.openid,
      scene: "profile",
      content: "公开备注",
    });
    const snapshot = await trace(w);
    const replay = await post("m.invitation.create", headers, {
      clientRequestId,
      remarkName: "另一备注",
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.data).toEqual(card);
    expect(api.wechat.callsOf("checkText")).toHaveLength(before + 1);
    expect(await trace(w)).toEqual(snapshot);
  });

  it.each(["block", "unavailable", "throw"] as const)(
    "真实当前会话内容检测%s失败关闭，HTTP错误明确且零业务写",
    async (mode) => {
      const w = await world(),
        before = await trace(w);
      const failed =
        mode === "throw"
          ? vi
              .spyOn(api.runtime.providers.wechat, "checkText")
              .mockRejectedValueOnce(new Error("检测传输故障"))
          : undefined;
      if (mode === "block") api.wechat.textVerdicts.push("block");
      if (mode === "unavailable") api.wechat.setTextCheckAvailable(false);
      try {
        const result = await post("m.invitation.create", w.owner.withStore(w.storeId), {
          clientRequestId: uuidv7(),
          remarkName: "需要检测",
        });
        expect(result.response.status).toBe(mode === "block" ? 400 : 503);
        expect(result.body.error).toBe(
          mode === "block" ? "CONTENT_REJECTED" : "PROVIDER_UNAVAILABLE",
        );
        expect(await trace(w)).toEqual(before);
      } finally {
        failed?.mockRestore();
        api.wechat.setTextCheckAvailable(true);
      }
    },
  );

  it("绑定仍 pending 即使时钟到期也返回原卡，匿名 lookup 只投影 expired 且零写", async () => {
    const w = await world(),
      headers = w.owner.withStore(w.storeId),
      clientRequestId = uuidv7();
    const result = await post("m.invitation.create", headers, { clientRequestId });
    expect(result.response.status).toBe(200);
    const card = InvitationCardSchema.parse(result.body.data),
      savedClock = api.clock.now();
    try {
      api.clock.set(new Date(card.expiresAt));
      const before = await trace(w);
      const replay = await post("m.invitation.create", headers, { clientRequestId });
      expect(replay.response.status).toBe(200);
      expect(InvitationCardSchema.parse(replay.body.data)).toMatchObject({
        invitationId: card.invitationId,
        token: card.token,
        expiresAt: card.expiresAt,
      });
      const preview = await lookup(card.token, {
        authorization: "not-a-bearer",
        "x-store-id": "bad",
      });
      expect(preview.response.status).toBe(200);
      expect(preview.response.headers.get("cache-control")).toBe("no-store");
      expect(InvitationPreviewSchema.parse(preview.body.data)).toMatchObject({
        invitationId: card.invitationId,
        status: "expired",
        expiresAt: card.expiresAt,
      });
      expect((await trace(w)).invitations[0]!.status).toBe("pending");
      expect(await trace(w)).toEqual(before);
    } finally {
      api.clock.set(savedClock);
    }
  });

  it("撤销的正式 idem 重放零副作用，原自然请求终态拒绝且匿名可读 revoked", async () => {
    const w = await world(),
      headers = w.owner.withStore(w.storeId),
      clientRequestId = uuidv7();
    const created = await post("m.invitation.create", headers, { clientRequestId });
    expect(created.response.status).toBe(200);
    const card = InvitationCardSchema.parse(created.body.data),
      key = uuidv7();
    const revoked = await post(
      "m.invitation.revoke",
      headers,
      { reason: "by_owner" },
      card.invitationId,
      key,
    );
    expect(revoked.response.status).toBe(200);
    expect(InvitationRevokeResultSchema.parse(revoked.body.data)).toEqual({
      invitationId: card.invitationId,
      status: "revoked",
      revokedAt: api.clock.now().toISOString(),
    });
    const after = await trace(w);
    expect(after.invitations[0]).toMatchObject({ status: "revoked", tokenEnc: null });
    expect(after.timers.find((row) => row.kind === "invitation.expire")!.status).toBe("cancelled");
    const replay = await post(
      "m.invitation.revoke",
      headers,
      { reason: "by_owner" },
      card.invitationId,
      key,
    );
    expect(replay.response.status).toBe(200);
    expect(replay.body.data).toEqual(revoked.body.data);
    const oldRequest = await post("m.invitation.create", headers, { clientRequestId });
    expect(oldRequest.response.status).toBe(409);
    expect(oldRequest.body.error).toBe("STATE_NOT_ALLOWED");
    const preview = await lookup(card.token);
    expect(preview.response.status).toBe(200);
    expect(InvitationPreviewSchema.parse(preview.body.data).status).toBe("revoked");
    expect(await trace(w)).toEqual(after);
  });

  it("严格 body/UUID/phone 与两个 required idem 的失败均不写业务事实", async () => {
    const w = await world(),
      headers = w.owner.withStore(w.storeId);
    const created = await post("m.invitation.create", headers, { clientRequestId: uuidv7() });
    expect(created.response.status).toBe(200);
    const card = InvitationCardSchema.parse(created.body.data),
      before = await trace(w);
    for (const body of [
      {},
      { clientRequestId: "bad" },
      { clientRequestId: "123E4567-E89B-42D3-A456-426614174000" },
      { clientRequestId: uuidv7(), targetPhone: "13800138000\n" },
      { clientRequestId: uuidv7(), targetPhone: 13800138000 },
      { clientRequestId: uuidv7(), remarkName: "🍜".repeat(11) },
      { clientRequestId: uuidv7(), role: "owner" },
    ]) {
      const invalid = await post("m.invitation.create", headers, body);
      expect(invalid.response.status).toBe(400);
      expect(invalid.body.error).toBe("VALIDATION_FAILED");
    }
    for (const op of ["m.invitation.markShared", "m.invitation.revoke"] as const) {
      const body = op === "m.invitation.revoke" ? { reason: "by_owner" } : undefined;
      const missing = await post(op, headers, body, card.invitationId);
      expect(missing.response.status).toBe(400);
      expect(missing.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
      const badId = await post(op, headers, body, "bad", uuidv7());
      expect(badId.response.status).toBe(400);
      expect(badId.body.error).toBe("VALIDATION_FAILED");
    }
    const reason = await post(
      "m.invitation.revoke",
      headers,
      { reason: "expired" },
      card.invitationId,
      uuidv7(),
    );
    expect(reason.response.status).toBe(400);
    expect(reason.body.error).toBe("VALIDATION_FAILED");
    expect(await trace(w)).toEqual(before);
  });

  it.each(["guest", "clerk", "unbound", "foreign"] as const)(
    "%s 不能调用三个写入口",
    async (mode) => {
      const w = await world();
      const created = await post("m.invitation.create", w.owner.withStore(w.storeId), {
        clientRequestId: uuidv7(),
      });
      expect(created.response.status).toBe(200);
      const card = InvitationCardSchema.parse(created.body.data),
        before = await trace(w);
      const headers =
        mode === "guest"
          ? {}
          : mode === "clerk"
            ? w.clerk.withStore(w.storeId)
            : mode === "foreign"
              ? w.owner.withStore((await world()).storeId)
              : (await signInAsMerchant(api)).withStore(w.storeId);
      for (const op of [
        "m.invitation.create",
        "m.invitation.markShared",
        "m.invitation.revoke",
      ] as const) {
        const result = await post(
          op,
          headers,
          op === "m.invitation.create"
            ? { clientRequestId: uuidv7() }
            : op === "m.invitation.revoke"
              ? { reason: "by_owner" }
              : undefined,
          card.invitationId,
          uuidv7(),
        );
        expect(result.response.status).toBe(mode === "guest" ? 401 : 403);
        expect(result.body.error).toBe(
          mode === "guest" ? "AUTH_REQUIRED" : mode === "clerk" ? "ROLE_FORBIDDEN" : "NOT_A_MEMBER",
        );
      }
      expect(await trace(w)).toEqual(before);
    },
  );

  it("同主体其他门店隐藏邀请与自然绑定，不能修改原卡", async () => {
    const w = await world(),
      clientRequestId = uuidv7();
    const created = await post("m.invitation.create", w.owner.withStore(w.storeId), {
      clientRequestId,
    });
    expect(created.response.status).toBe(200);
    const card = InvitationCardSchema.parse(created.body.data),
      before = await trace(w),
      headers = w.owner.withStore(w.second.id);
    for (const op of [
      "m.invitation.create",
      "m.invitation.markShared",
      "m.invitation.revoke",
    ] as const) {
      const result = await post(
        op,
        headers,
        op === "m.invitation.create"
          ? { clientRequestId }
          : op === "m.invitation.revoke"
            ? { reason: "by_owner" }
            : undefined,
        card.invitationId,
        uuidv7(),
      );
      expect(result.response.status).toBe(404);
      expect(result.body.error).toBe("NOT_FOUND");
    }
    expect(await trace(w)).toEqual(before);
  });

  it("匿名九字段预览不解析坏凭据，令牌/额外query拒绝且查询全部零写", async () => {
    const w = await world();
    const created = await post("m.invitation.create", w.owner.withStore(w.storeId), {
      clientRequestId: uuidv7(),
      targetPhone: "13800138000",
    });
    expect(created.response.status).toBe(200);
    const card = InvitationCardSchema.parse(created.body.data),
      before = await trace(w);
    const anonymous = await lookup(card.token, {
      authorization: "Bearer broken",
      "x-store-id": uuidv7(),
    });
    expect(anonymous.response.status).toBe(200);
    const preview = InvitationPreviewSchema.parse(anonymous.body.data);
    expect(Object.keys(preview).sort()).toEqual([
      "category",
      "city",
      "expiresAt",
      "invitationId",
      "inviterName",
      "isPhoneRestricted",
      "role",
      "status",
      "storeName",
    ]);
    expect(preview).toMatchObject({
      invitationId: card.invitationId,
      status: "pending",
      isPhoneRestricted: true,
      role: "clerk",
    });
    for (const key of [
      "token",
      "targetPhone",
      "targetPhoneBidx",
      "remarkName",
      "seats",
      "entityId",
      "storeId",
    ])
      expect(preview).not.toHaveProperty(key);
    for (const token of ["bad", card.token + "\n", "a".repeat(42) + "="]) {
      const result = await lookup(token);
      expect(result.response.status).toBe(400);
      expect(result.body.error).toBe("VALIDATION_FAILED");
    }
    const unknown = await lookup("z".repeat(43));
    expect(unknown.response.status).toBe(404);
    expect(unknown.body.error).toBe("INVITATION_INVALID");
    const extra = await api.request(
      `${paths["m.invitation.lookup"]}?token=${card.token}&targetPhone=13800138000`,
    );
    expect(extra.status).toBe(400);
    expect(await trace(w)).toEqual(before);
  });
});
