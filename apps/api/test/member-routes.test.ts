// W1-04b：七条生产处理器，走真实鉴权、同意门与幂等链。
import {
  AgreementConsentReceiptSchema,
  BootstrapSchema,
  DictItemListResultSchema,
  MembershipResultSchema,
  MeViewSchema,
  SignedAgreementListSchema,
  StoreListSchema,
} from "@liyoxi/contract";
import { createFactories } from "@liyoxi/services/testing";
import { AppError, uuidv7 } from "@liyoxi/services";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import {
  currentUserConsents,
  seedUserAgreements,
  signInAsMerchant,
} from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const testApi = useTestApi();
let api: TestApi;
let owner: SignedInMerchant;
let clerk: SignedInMerchant;
let concurrentUser: SignedInMerchant;
let entityId: string;
let storeId: string;
let secondStoreId: string;
async function call(path: string, init: TestRequestInit = {}) {
  const response = await api.request(`/api/v1${path}`, init);
  const body = (await response.json()) as { data?: unknown; error?: string };
  return { response, body };
}
const keyed = (merchant: SignedInMerchant, key: string, store?: string) => ({
  ...(store === undefined ? merchant.headers : merchant.withStore(store)),
  "Idempotency-Key": key,
});

beforeAll(async () => {
  api = await testApi.start();
  await seedUserAgreements(testApi, api);
  owner = await signInAsMerchant(api);
  const created = await call("/m/entities", {
    method: "POST",
    json: {},
    headers: keyed(owner, "fixture-owner"),
  });
  expect(created.response.status).toBe(200);
  const membership = MembershipResultSchema.parse(created.body.data);
  ({ entityId, storeId } = membership);
  const db = await testApi.db.prisma();
  const make = createFactories({ db, clock: api.clock });
  secondStoreId = (
    await make.store({
      entityId,
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: api.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: owner.merchantUserId,
      archiveClient: "weapp",
    })
  ).id;
  clerk = await signInAsMerchant(api);
  const member = await make.entityMember({
    entityId,
    merchantUserId: clerk.merchantUserId,
    lastStoreId: storeId,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId,
    addedByMemberId: membership.memberId,
  });
  await make.agreementConsent({ entityId, storeId, merchantUserId: owner.merchantUserId });
  const now = { createdAt: api.clock.now(), updatedAt: api.clock.now() };
  await db.dictType.createMany({
    data: [
      {
        ...now,
        typeKey: "industry",
        name: "行业",
        structure: "tree",
        maxDepth: 2,
        disablePolicy: "free",
        isMerchantVisible: true,
        versionNo: 7,
      },
      {
        ...now,
        typeKey: "region",
        name: "区划",
        structure: "tree",
        maxDepth: 2,
        disablePolicy: "free",
        isMerchantVisible: true,
      },
      {
        ...now,
        typeKey: "ticket_type",
        name: "工单类型",
        structure: "flat",
        maxDepth: 1,
        disablePolicy: "free",
        isMerchantVisible: true,
      },
      {
        ...now,
        typeKey: "reject_reason",
        name: "内部原因",
        structure: "flat",
        maxDepth: 1,
        disablePolicy: "free",
        isMerchantVisible: false,
      },
    ],
  });
  const item = (dictTypeKey: string, code: string, name: string) => ({
    ...now,
    id: uuidv7(),
    dictTypeKey,
    code,
    name,
  });
  await db.dictItem.createMany({
    data: [
      {
        ...item("industry", "C01", "开放行业"),
        ext: { open: true, special: false, requiredCerts: ["food_business"], internal: "secret" },
      },
      {
        ...item("industry", "C02", "未开放行业"),
        ext: { open: false, special: true, requiredCerts: [] },
      },
      {
        ...item("industry", "C03", "停用行业"),
        isEnabled: false,
        ext: { open: true, special: false, requiredCerts: [] },
      },
      {
        ...item("region", "510000", "开通区划"),
        ext: { opened: true, level: 1, functionalZone: false },
      },
      {
        ...item("region", "520000", "未开通区划"),
        ext: { opened: false, level: 1, functionalZone: false },
      },
      {
        ...item("ticket_type", "K01", "售后"),
        ext: { isAfterSales: true, defaultPriority: "mid", transferable: true, notifyLead: false },
      },
    ],
  });
  await db.dictItem.create({
    data: {
      ...item("industry", "C0101", "子行业"),
      parentCode: "C01",
      ext: { open: true, special: false, requiredCerts: [] },
    },
  });
}, 180_000);

describe("主体与门店", () => {
  it('"m.entity.create"：严格空对象、缺键、新建、同键重放及新键返回已有主体', async () => {
    const user = await signInAsMerchant(api);
    const missing = await call("/m/entities", { method: "POST", json: {}, headers: user.headers });
    expect([missing.response.status, missing.body.error]).toEqual([
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    ]);
    const invalid = await call("/m/entities", {
      method: "POST",
      json: { name: "不能从这里建档" },
      headers: keyed(user, "invalid-entity"),
    });
    expect([invalid.response.status, invalid.body.error]).toEqual([400, "VALIDATION_FAILED"]);
    const request = { method: "POST", json: {}, headers: keyed(user, "create-entity") };
    const first = await call("/m/entities", request);
    expect(first.response.status).toBe(200);
    const result = MembershipResultSchema.parse(first.body.data);
    expect(result.isNew).toBe(true);
    const replay = await call("/m/entities", request);
    expect(replay.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replay.body.data).toEqual(first.body.data);
    const again = await call("/m/entities", {
      ...request,
      headers: keyed(user, "existing-entity"),
    });
    expect(MembershipResultSchema.parse(again.body.data)).toMatchObject({
      entityId: result.entityId,
      isNew: false,
    });
    const db = await testApi.db.prisma();
    expect(await db.entity.count({ where: { createdByUserId: user.merchantUserId } })).toBe(1);
    const me = await call("/m/me", { headers: user.headers });
    expect(MeViewSchema.parse(me.body.data).memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: expect.objectContaining({ entityId: result.entityId }) }),
      ]),
    );
    const denied = await call("/m/entities", {
      method: "POST",
      json: {},
      headers: keyed(clerk, "clerk-entity"),
    });
    expect([denied.response.status, denied.body.error]).toEqual([409, "ALREADY_IN_ENTITY"]);
  });
  it('"m.store.list"：无门店头的 none/owner/clerk 三种视图，店员没有主体额度或老板字段', async () => {
    const unbound = await signInAsMerchant(api);
    const none = await call("/m/stores", { headers: unbound.headers });
    expect(none.response.status).toBe(200);
    expect(StoreListSchema.parse(none.body.data)).toEqual({
      viewerRole: "none",
      entity: null,
      items: [],
    });
    const owners = await call("/m/stores", { headers: owner.headers });
    expect(owners.response.status).toBe(200);
    const full = StoreListSchema.parse(owners.body.data);
    expect(full.viewerRole).toBe("owner");
    expect(full.entity).toHaveProperty("storesUsed");
    expect(full.items.map((item) => item.storeId)).toEqual(
      expect.arrayContaining([storeId, secondStoreId]),
    );
    const clerks = await call("/m/stores", { headers: clerk.headers });
    expect(clerks.response.status).toBe(200);
    const trimmed = StoreListSchema.parse(clerks.body.data);
    expect(trimmed.viewerRole).toBe("clerk");
    expect(trimmed.entity).not.toHaveProperty("storesUsed");
    expect(trimmed.items).toHaveLength(1);
    expect(trimmed.items[0]).not.toHaveProperty("liveCount");
    expect(trimmed.items[0]?.actions).toEqual([]);
  });
  it('"m.me.currentStore.replace"：老板可记住停用门店并重放；me/引导随选择更新，选择不授权外店', async () => {
    const request = {
      method: "PUT",
      json: { storeId: secondStoreId },
      headers: keyed(owner, "remember-archived", secondStoreId),
    };
    const first = await call("/m/me/current-store", request);
    expect(first.response.status).toBe(200);
    expect(first.body.data).toEqual({ storeId: secondStoreId });
    const replay = await call("/m/me/current-store", request);
    expect(replay.response.headers.get("Idempotent-Replayed")).toBe("true");
    expect(replay.body.data).toEqual(first.body.data);
    const me = await call("/m/me", { headers: owner.headers });
    expect(MeViewSchema.parse(me.body.data).memberships[0]?.lastStoreId).toBe(secondStoreId);
    const boot = await call("/m/bootstrap", { headers: owner.headers });
    expect(BootstrapSchema.parse(boot.body.data).context).toEqual({ storeId: secondStoreId });
    const foreign = await call("/m/me/current-store", {
      method: "PUT",
      json: { storeId: uuidv7() },
      headers: keyed(owner, "remember-foreign", storeId),
    });
    expect([foreign.response.status, foreign.body.error]).toEqual([404, "NOT_FOUND"]);
    const noKey = await call("/m/me/current-store", {
      method: "PUT",
      json: { storeId },
      headers: owner.withStore(storeId),
    });
    expect([noKey.response.status, noKey.body.error]).toEqual([400, "IDEMPOTENCY_KEY_REQUIRED"]);
    const noContext = await call("/m/me/current-store", {
      method: "PUT",
      json: { storeId },
      headers: keyed(owner, "missing-context"),
    });
    expect([noContext.response.status, noContext.body.error]).toEqual([403, "NOT_A_MEMBER"]);
  });
  it("幂等保存原始结果，重放仍按当前请求裁剪：写接口不返回多余字段", async () => {
    const tenant = merchantServicesOf(api.runtime).tenant;
    const extra = vi.spyOn(tenant, "rememberCurrentStore").mockImplementation((input, options) =>
      // 真写与授权在上一例验证；此处注入原始内部字段，钉住路由裁剪发生在提交之后。
      api.runtime.tx.run(async () => ({ storeId: input.storeId, balance: 1 }), options),
    );
    try {
      const request = {
        method: "PUT",
        json: { storeId },
        headers: keyed(clerk, "raw-result", storeId),
      };
      const first = await call("/m/me/current-store", request);
      expect(first.response.status).toBe(200);
      expect(first.body.data).toEqual({ storeId });
      const db = await testApi.db.prisma();
      const row = await db.idempotencyRecord.findFirstOrThrow({ where: { key: "raw-result" } });
      expect(row.result).toMatchObject({ balance: 1 });
      const replay = await call("/m/me/current-store", request);
      expect(replay.response.headers.get("Idempotent-Replayed")).toBe("true");
      expect(replay.body.data).toEqual({ storeId });
    } finally {
      extra.mockRestore();
    }
  });
});

describe("协议与字典", () => {
  it('"m.agreementConsent.list" / "m.agreementConsent.summary"：计数同老板行数，店员仅本人用户协议且不能计数', async () => {
    const owners = await call("/m/agreement-consents", { headers: owner.withStore(storeId) });
    expect(owners.response.status).toBe(200);
    const full = SignedAgreementListSchema.parse(owners.body.data);
    expect(full.viewerRole).toBe("owner");
    expect(full.items.some((item) => item.subjectKind === "entity")).toBe(true);
    const summary = await call("/m/agreement-consents/summary", {
      headers: owner.withStore(storeId),
    });
    expect(summary.response.status).toBe(200);
    expect(summary.body.data).toEqual({ all: full.items.length });
    const clerks = await call("/m/agreement-consents", { headers: clerk.withStore(storeId) });
    expect(clerks.response.status).toBe(200);
    const trimmed = SignedAgreementListSchema.parse(clerks.body.data);
    expect(trimmed.viewerRole).toBe("clerk");
    expect(trimmed.items).toHaveLength(2);
    for (const item of trimmed.items) {
      expect(item.subjectKind).toBe("user");
      expect(item.latestConsent).not.toHaveProperty("bizNo");
      expect(item.firstConsent).not.toHaveProperty("bizType");
    }
    const denied = await call("/m/agreement-consents/summary", {
      headers: clerk.withStore(storeId),
    });
    expect([denied.response.status, denied.body.error]).toEqual([403, "ROLE_FORBIDDEN"]);
    for (const headers of [owner.headers, owner.withStore(uuidv7())]) {
      const invalid = await call("/m/agreement-consents", { headers });
      expect([invalid.response.status, invalid.body.error]).toEqual([403, "NOT_A_MEMBER"]);
    }
  });
  it('"m.dictItem.list"：公开字典按可选性与 ext 白名单下发，含停用与直系下级筛选、版本同引导', async () => {
    const publicResult = await call("/m/dict-items?typeKey=industry,region,ticket_type");
    expect(publicResult.response.status).toBe(200);
    const data = DictItemListResultSchema.parse(publicResult.body.data);
    expect(data.items.map((item) => item.typeKey)).toEqual(["industry", "region", "ticket_type"]);
    expect(data.items[0]?.items.map((item) => item.code)).toEqual(["C01", "C0101"]);
    expect(data.items[0]?.items[0]?.ext).toEqual({
      special: false,
      requiredCerts: ["food_business"],
    });
    expect(data.items[1]?.items.map((item) => item.code)).toEqual(["510000"]);
    expect(data.items[2]?.items[0]?.ext).toEqual({ isAfterSales: true });
    expect(data.items[0]).not.toHaveProperty("isMerchantVisible");
    expect(data.items[0]?.items[0]).not.toHaveProperty("isEnabled");
    const all = await call("/m/dict-items?typeKey=industry&includeDisabled=true");
    expect(
      DictItemListResultSchema.parse(all.body.data)
        .items[0]?.items.filter((item) => !item.isSelectable)
        .map((item) => item.code),
    ).toEqual(["C02", "C03"]);
    const children = await call("/m/dict-items?typeKey=industry&parentCode=C01");
    expect(
      DictItemListResultSchema.parse(children.body.data).items[0]?.items.map((item) => item.code),
    ).toEqual(["C0101"]);
    const boot = await call("/m/bootstrap");
    expect(BootstrapSchema.parse(boot.body.data).versions.dict.industry).toBe(
      data.items[0]?.versionNo,
    );
    for (const query of [
      "typeKey=reject_reason",
      "typeKey=unknown",
      "typeKey=industry,region&parentCode=C01",
      "typeKey=ticket_type&parentCode=K01",
      "typeKey=industry&includeDisabled=1",
      "typeKey=",
      "",
      `typeKey=${Array(11).fill("industry").join(",")}`,
    ]) {
      const invalid = await call(`/m/dict-items?${query}`);
      expect([invalid.response.status, invalid.body.error], query).toEqual([
        400,
        "VALIDATION_FAILED",
      ]);
    }
  });
  it('"m.agreementConsent.create"：428 在幂等前拦截，分步重新同意后同键建主体成功且指纹免查记录', async () => {
    const user = await signInAsMerchant(api);
    concurrentUser = await signInAsMerchant(api);
    const db = await testApi.db.prisma();
    const make = createFactories({ db, clock: api.clock });
    const identity = merchantServicesOf(api.runtime).identity;
    const old = await db.agreementVersion.findFirstOrThrow({
      where: { agreementKey: "user", status: "active" },
    });
    const next = await make.agreementVersion({ agreementKey: "user", status: "pending" });
    const privacy = await make.agreementVersion({ agreementKey: "privacy", status: "pending" });
    identity.consentGate.invalidate();
    const headers = keyed(user, "after-reconsent");
    const blocked = await call("/m/entities", { method: "POST", json: {}, headers });
    expect([blocked.response.status, blocked.body.error]).toEqual([428, "CONSENT_REQUIRED"]);
    expect(await db.idempotencyRecord.count({ where: { key: "after-reconsent" } })).toBe(0);
    const userConsent = { agreementKey: "user", agreementVersionId: next.id };
    const before = await db.merchantUser.findUniqueOrThrow({ where: { id: user.merchantUserId } });
    const partial = await call("/m/agreement-consents", {
      method: "POST",
      json: { consents: [userConsent], device: { model: "test-device" } },
      headers: { ...user.headers, "User-Agent": "a".repeat(350), "X-Client-Version": "1.2.3" },
    });
    expect(partial.response.status).toBe(200);
    const receipt = AgreementConsentReceiptSchema.parse(partial.body.data);
    expect(receipt.pendingConsents.map((consent) => consent.agreementKey)).toEqual(["privacy"]);
    expect(
      (await db.merchantUser.findUniqueOrThrow({ where: { id: user.merchantUserId } }))
        .consentStamp,
    ).toBe(before.consentStamp);
    const repeated = await call("/m/agreement-consents", {
      method: "POST",
      json: { consents: [userConsent] },
      headers: user.headers,
    });
    expect(
      AgreementConsentReceiptSchema.parse(repeated.body.data).consents[0]?.agreementConsentId,
    ).toBe(receipt.consents[0]?.agreementConsentId);
    const stale = await call("/m/agreement-consents", {
      method: "POST",
      json: { consents: [{ agreementKey: "user", agreementVersionId: old.id }] },
      headers: user.headers,
    });
    expect([stale.response.status, stale.body.error]).toEqual([409, "AGREEMENT_VERSION_STALE"]);
    const complete = await call("/m/agreement-consents", {
      method: "POST",
      json: { consents: [{ agreementKey: "privacy", agreementVersionId: privacy.id }] },
      headers: user.headers,
    });
    expect(AgreementConsentReceiptSchema.parse(complete.body.data).pendingConsents).toEqual([]);
    const records = vi.spyOn(merchantServicesOf(api.runtime).docs, "pendingConsents");
    try {
      const allowed = await call("/m/entities", { method: "POST", json: {}, headers });
      expect(allowed.response.status).toBe(200);
      const stores = await call("/m/stores", { headers: user.headers });
      expect(stores.response.status).toBe(200);
      expect(records).not.toHaveBeenCalled();
    } finally {
      records.mockRestore();
    }
    const stored = await db.agreementConsent.findUniqueOrThrow({
      where: { id: receipt.consents[0]!.agreementConsentId },
    });
    expect(stored).toMatchObject({
      scene: "reconsent",
      method: "checkbox",
      entityId: null,
      bizType: null,
      userAgent: "a".repeat(300),
      deviceSnapshot: { model: "test-device", appVersion: "1.2.3" },
    });
  });
  it("重新同意写入中故障整事务回滚；同一用户并发提交只留各版本一条且回执相同", async () => {
    const db = await testApi.db.prisma();
    const consents = await currentUserConsents(api);
    const ids = consents.map((consent) => consent.agreementVersionId);
    const before = await db.merchantUser.findUniqueOrThrow({
      where: { id: concurrentUser.merchantUserId },
    });
    const docs = merchantServicesOf(api.runtime).docs;
    const original = docs.assertConsents;
    const fail = vi.spyOn(docs, "assertConsents").mockImplementation(async (tx, ctx, input) => {
      await original(tx, ctx, input);
      throw new AppError("INTERNAL");
    });
    const request = { method: "POST", json: { consents }, headers: concurrentUser.headers };
    try {
      const failed = await call("/m/agreement-consents", request);
      expect([failed.response.status, failed.body.error]).toEqual([500, "INTERNAL"]);
      expect(
        await db.agreementConsent.count({
          where: { merchantUserId: concurrentUser.merchantUserId, agreementVersionId: { in: ids } },
        }),
      ).toBe(0);
      expect(
        (await db.merchantUser.findUniqueOrThrow({ where: { id: concurrentUser.merchantUserId } }))
          .consentStamp,
      ).toBe(before.consentStamp);
    } finally {
      fail.mockRestore();
    }
    const [first, second] = await Promise.all([
      call("/m/agreement-consents", request),
      call("/m/agreement-consents", request),
    ]);
    expect([first.response.status, second.response.status]).toEqual([200, 200]);
    expect(second.body.data).toEqual(first.body.data);
    expect(AgreementConsentReceiptSchema.parse(first.body.data).pendingConsents).toEqual([]);
    expect(
      await db.agreementConsent.count({
        where: { merchantUserId: concurrentUser.merchantUserId, agreementVersionId: { in: ids } },
      }),
    ).toBe(2);
    expect(
      (await db.merchantUser.findUniqueOrThrow({ where: { id: concurrentUser.merchantUserId } }))
        .consentStamp,
    ).not.toBe(before.consentStamp);
  });
});
