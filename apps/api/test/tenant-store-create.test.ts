import { StoreCardSchema } from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, snapshotTables } from "@liyoxi/services/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi;
const body = {
  name: "公开新分店",
  addressDetail: "公开新分店测试路一号",
  industryCode: "C970",
  categoryCode: "C971",
};
const tables = [
  "store",
  "store_profile",
  "store_service_item",
  "store_profile_media",
  "store_asset",
  "store_asset_file",
  "file_ref",
  "qualification_submission",
  "entity",
  "entity_member",
  "store_member",
  "status_transition",
  "audit_log",
  "outbox_event",
  "timer",
];
beforeAll(async () => {
  api = await handle.start();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  const db = await handle.db.prisma();
  for (const [code, parentCode] of [
    ["C970", null],
    ["C971", "C970"],
  ] as const)
    await db.dictItem.create({
      data: {
        id: uuidv7(),
        dictTypeKey: "industry",
        code,
        parentCode,
        name: "创建测试开放行业",
        ext: { open: true, special: false, requiredCerts: [] },
        isEnabled: true,
        position: 997,
        createdAt: api.clock.now(),
        updatedAt: api.clock.now(),
      },
    });
}, 180_000);
afterEach(() => {
  api.wechat.textVerdicts.length = 0;
  api.wechat.setTextCheckAvailable(true);
});

async function world() {
  const owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const db = await handle.db.prisma(),
    make = createFactories({ db, clock: api.clock });
  await db.entity.update({ where: { id: created.entityId }, data: { storeLimitOverride: 4 } });
  return { owner, ...created, db, make };
}
async function post(
  headers: Record<string, string>,
  json: unknown = body,
  key: string | null = uuidv7(),
) {
  const response = await api.request("/api/v1/m/stores", {
    method: "POST",
    json,
    headers: { ...headers, ...(key === null ? {} : { "Idempotency-Key": key }) },
  });
  return {
    response,
    body: (await response.json()) as { data?: unknown; error?: string; details?: unknown },
  };
}

describe("m.store.create 真实HTTP及固定公开组合", { timeout: 120_000 }, () => {
  it.each([false, true])("copy=%s 初次INSERT元数据、真实老板卡、事件与资格不复制", async (copy) => {
    const w = await world(),
      before = await snapshotTables(w.db, ["entity_member", "store_member"]);
    const source = await w.db.store.findUniqueOrThrow({ where: { id: w.storeId } });
    const result = await post(w.owner.withStore(w.storeId), {
      ...body,
      name: `  ${body.name}  `,
      ...(copy
        ? { copyFromStoreId: w.storeId, copyOptions: ["basic", "service", "media", "brand_assets"] }
        : {}),
    });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    const card = StoreCardSchema.parse(result.body.data);
    expect(result.body.data).toEqual(card);
    const list = await api.request("/api/v1/m/stores", { headers: w.owner.headers });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      data: { viewerRole: "owner", items: expect.arrayContaining([card]) },
    });
    expect(card).toMatchObject({
      name: body.name,
      isPrimary: false,
      lifecycle: "active",
      qualificationStatus: "unsubmitted",
      assetCount: 0,
      clerkCount: 0,
      pendingInvitationCount: 0,
      submittedAt: null,
      expectedDecisionAt: null,
      verifiedAt: null,
      actions: ["archive", "delete"],
    });
    expect(await w.db.store.findUniqueOrThrow({ where: { id: card.storeId } })).toMatchObject({
      entityId: w.entityId,
      isPrimary: false,
      lifecycle: "active",
      qualificationStatus: "unsubmitted",
    });
    expect(
      await w.db.storeProfile.findUniqueOrThrow({ where: { storeId: card.storeId } }),
    ).toMatchObject({
      entityId: w.entityId,
      addressDetail: body.addressDetail,
      industryCode: body.industryCode,
      categoryCode: body.categoryCode,
      copiedFromStoreId: copy ? w.storeId : null,
      copyOptions: copy ? ["basic", "service", "media", "brand_assets"] : [],
    });
    expect(await w.db.store.findUniqueOrThrow({ where: { id: w.storeId } })).toEqual(source);
    expect(await snapshotTables(w.db, ["entity_member", "store_member"])).toEqual(before);
    expect(
      await w.db.statusTransition.findMany({ where: { subjectId: card.storeId } }),
    ).toMatchObject([
      {
        event: "store.create",
        fromState: null,
        toState: "active",
        actorId: w.owner.merchantUserId,
      },
    ]);
    expect(await w.db.auditLog.count({ where: { targetId: card.storeId } })).toBe(1);
    expect(await w.db.outboxEvent.findMany({ where: { aggregateId: card.storeId } })).toMatchObject(
      [
        {
          eventType: "store.created",
          payload: {
            v: 1,
            storeId: card.storeId,
            entityId: w.entityId,
            isFirstStore: false,
            fromState: null,
            toState: "active",
            transition: "store.create",
          },
        },
      ],
    );
    expect(await w.db.qualificationSubmission.count({ where: { storeId: card.storeId } })).toBe(0);
  });

  it("required 同键返回原完整响应且零外检/零业务旁写，body或门店上下文不同冲突", async () => {
    const w = await world(),
      key = uuidv7();
    const first = await post(w.owner.withStore(w.storeId), body, key);
    expect(first.response.status, JSON.stringify(first.body)).toBe(200);
    const card = StoreCardSchema.parse(first.body.data),
      before = await snapshotTables(w.db, tables);
    const checks = api.wechat.callsOf("checkText").length;
    const again = await post(w.owner.withStore(w.storeId), body, key);
    expect(again.response.status).toBe(200);
    expect(again.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(api.wechat.callsOf("checkText")).toHaveLength(checks);
    for (const [headers, input] of [
      [w.owner.withStore(w.storeId), { ...body, name: "不同分店" }],
      [w.owner.withStore(card.storeId), body],
    ] as const) {
      const conflict = await post(headers, input, key);
      expect(conflict.response.status).toBe(409);
      expect(conflict.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(await snapshotTables(w.db, tables)).toEqual(before);
  });

  it.each(["name", "addressDetail", "both", "unavailable"] as const)(
    "真实内容检测 %s 失败拒绝整笔且错误仅投影正式字段",
    async (mode) => {
      const w = await world(),
        before = await snapshotTables(w.db, tables);
      const start = api.wechat.callsOf("checkText").length;
      if (mode === "unavailable") api.wechat.setTextCheckAvailable(false);
      else
        api.wechat.textVerdicts.push(
          mode === "addressDetail" ? "pass" : "block",
          mode === "name" ? "pass" : "block",
        );
      const result = await post(w.owner.withStore(w.storeId));
      expect(result.response.status).toBe(mode === "unavailable" ? 503 : 400);
      expect(result.body.error).toBe(
        mode === "unavailable" ? "PROVIDER_UNAVAILABLE" : "CONTENT_REJECTED",
      );
      if (mode !== "unavailable")
        expect(result.body.details).toEqual({
          fields: mode === "both" ? ["name", "addressDetail"] : [mode],
        });
      const calls = api.wechat.callsOf("checkText").slice(start);
      expect(calls).toHaveLength(mode === "unavailable" ? 1 : 2);
      expect(calls[0]!.input).toEqual({
        openid: w.owner.openid,
        scene: "profile",
        content: body.name,
      });
      if (mode !== "unavailable")
        expect(calls[1]!.input).toEqual({
          openid: w.owner.openid,
          scene: "profile",
          content: body.addressDetail,
        });
      expect(await snapshotTables(w.db, tables)).toEqual(before);
    },
  );

  it.each(["missing", "disabled", "closed", "wrong_parent"] as const)(
    "%s 行业品类沿真实Profile规则拒绝",
    async (mode) => {
      const w = await world();
      const code = `C${uuidv7().replaceAll("-", "").slice(-12)}`;
      if (mode !== "missing")
        await w.db.dictItem.create({
          data: {
            id: uuidv7(),
            dictTypeKey: "industry",
            code,
            parentCode: mode === "wrong_parent" ? null : body.industryCode,
            name: `公开拒绝品类-${mode}`,
            isEnabled: mode !== "disabled",
            position: 999,
            ext: { open: mode !== "closed", special: false, requiredCerts: [] },
            createdAt: api.clock.now(),
            updatedAt: api.clock.now(),
          },
        });
      const before = await snapshotTables(w.db, tables);
      const result = await post(w.owner.withStore(w.storeId), { ...body, categoryCode: code });
      expect(result.response.status).toBe(mode === "disabled" || mode === "closed" ? 409 : 400);
      expect(result.body.error).toBe(
        mode === "disabled"
          ? "DICT_ITEM_DISABLED"
          : mode === "closed"
            ? "INDUSTRY_NOT_OPEN"
            : "VALIDATION_FAILED",
      );
      expect(await snapshotTables(w.db, tables)).toEqual(before);
    },
  );

  it("当前真实额度失败精确三键；同键额度恢复后可新建，不缓存失败", async () => {
    const w = await world(),
      key = uuidv7();
    await w.db.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 1 } });
    const before = await snapshotTables(w.db, tables);
    const limited = await post(w.owner.withStore(w.storeId), body, key);
    expect(limited.response.status).toBe(409);
    expect(limited.body).toMatchObject({
      error: "STORE_LIMIT_REACHED",
      details: { storesUsed: 1, storeLimit: 1, limitReason: "inactive" },
    });
    expect(await snapshotTables(w.db, tables)).toEqual(before);
    await w.db.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 2 } });
    const success = await post(w.owner.withStore(w.storeId), body, key);
    expect(success.response.status, JSON.stringify(success.body)).toBe(200);
    expect(StoreCardSchema.parse(success.body.data).isPrimary).toBe(false);
  });

  it.each([
    "guest",
    "unbound",
    "clerk",
    "foreign_context",
    "no_store",
    "archived",
    "no_idem",
    "bad_idem",
  ] as const)("%s 真实中间件拒绝且未外检/业务零写", async (mode) => {
    const w = await world();
    const other = ["unbound", "clerk", "foreign_context"].includes(mode)
      ? await signInAsMerchant(api)
      : null;
    if (mode === "clerk") {
      const member = await w.make.entityMember({
        entityId: w.entityId,
        merchantUserId: other!.merchantUserId,
      });
      await w.make.storeMember({
        entityMemberId: member.id,
        storeId: w.storeId,
        addedByMemberId: w.memberId,
      });
    }
    if (mode === "archived") {
      const archived = await w.make.store({ entityId: w.entityId });
      await merchantServicesOf(api.runtime).tenant.archiveStore(
        createIdentityContext({
          actor: { type: "merchant", id: w.owner.merchantUserId, client: "weapp" },
          entityId: w.entityId,
          storeId: w.storeId,
        }),
        { storeId: archived.id },
      );
      w.storeId = archived.id;
    }
    const before = await snapshotTables(w.db, tables),
      checks = api.wechat.callsOf("checkText").length;
    const headers =
      mode === "guest"
        ? {}
        : mode === "no_store"
          ? w.owner.headers
          : other
            ? other.withStore(w.storeId)
            : w.owner.withStore(w.storeId);
    const result = await post(
      headers,
      body,
      mode === "no_idem" ? null : mode === "bad_idem" ? "!" : uuidv7(),
    );
    const expected = {
      guest: [401, "AUTH_REQUIRED"],
      unbound: [403, "NOT_A_MEMBER"],
      clerk: [403, "ROLE_FORBIDDEN"],
      foreign_context: [403, "NOT_A_MEMBER"],
      no_store: [403, "NOT_A_MEMBER"],
      archived: [403, "STORE_ARCHIVED"],
      no_idem: [400, "IDEMPOTENCY_KEY_REQUIRED"],
      bad_idem: [400, "IDEMPOTENCY_KEY_REQUIRED"],
    }[mode];
    expect(result.response.status).toBe(expected[0]);
    expect(result.body.error).toBe(expected[1]);
    expect(api.wechat.callsOf("checkText")).toHaveLength(checks);
    expect(await snapshotTables(w.db, tables)).toEqual(before);
  });

  it.each([{ name: "一" }, { copyOptions: ["basic"] }, { force: true }, { isPrimary: true }])(
    "严格body %j 在外检之前拒绝",
    async (patch) => {
      const w = await world(),
        before = await snapshotTables(w.db, tables);
      const count = api.wechat.callsOf("checkText").length;
      const result = await post(w.owner.withStore(w.storeId), { ...body, ...patch });
      expect(result.response.status).toBe(400);
      expect(result.body.error).toBe("VALIDATION_FAILED");
      expect(api.wechat.callsOf("checkText")).toHaveLength(count);
      expect(await snapshotTables(w.db, tables)).toEqual(before);
    },
  );
});
