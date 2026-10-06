import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, currentSessionOpenid, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import type {
  StoreProfileOverviewSchema,
  QualificationViewSchema,
  QualificationDocRecognizedSchema,
  QualificationDocUpdateResultSchema,
} from "@liyoxi/contract";
import type { z } from "zod";
type StoreProfileOverview = z.infer<typeof StoreProfileOverviewSchema>;
type QualificationView = z.infer<typeof QualificationViewSchema>;
type QualificationDocRecognized = z.infer<typeof QualificationDocRecognizedSchema>;
type QualificationDocUpdateResult = z.infer<typeof QualificationDocUpdateResultSchema>;
import { merchantServicesOf } from "../src/merchant/services.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
const handle = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  storeId: string,
  entityId: string;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let peer = 0;
const routes = [
  ["m.storeProfile.get", "GET", "/m/store-profile"],
  ["m.storeProfile.basic.get", "GET", "/m/store-profile/basic"],
  ["m.storeProfile.basic.update", "PATCH", "/m/store-profile/basic"],
  ["m.storeProfile.media.get", "GET", "/m/store-profile/media"],
  ["m.storeProfile.media.update", "PATCH", "/m/store-profile/media"],
  ["m.storeProfile.service.get", "GET", "/m/store-profile/service"],
  ["m.storeProfile.service.update", "PATCH", "/m/store-profile/service"],
  ["m.storeProfile.qualification.get", "GET", "/m/store-profile/qualification"],
  ["m.storeProfile.qualification.update", "PATCH", "/m/store-profile/qualification"],
  ["m.storeProfile.contact.update", "PATCH", "/m/store-profile/contact"],
  ["m.storeProfile.qualification.submit", "POST", "/m/store-profile/qualification/submit"],
  ["m.qualificationDoc.create", "POST", "/m/qualification-docs"],
  ["m.qualificationDoc.update", "PATCH", `/m/qualification-docs/${uuidv7()}`],
] as const;
async function request(
  op: (typeof routes)[number][0],
  json?: unknown,
  path?: string,
  key = uuidv7(),
) {
  const route = routes.find((row) => row[0] === op)!;
  return api.request(`/api/v1${path ?? route[2]}`, {
    method: route[1],
    ...(json === undefined ? {} : { json }),
    headers: { ...owner.withStore(storeId), "Idempotency-Key": key },
    peer: `198.19.108.${++peer}`,
  });
}
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  const created = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  ({ storeId, entityId } = created);
  clerk = await signInAsMerchant(api);
  const make = createFactories({ db: prisma, clock: api.clock });
  const member = await make.entityMember({ entityId, merchantUserId: clerk.merchantUserId });
  await make.storeMember({ entityMemberId: member.id, storeId, addedByMemberId: created.memberId });
  for (const item of [
    {
      dictTypeKey: "industry",
      code: "C900",
      name: "API开放行业",
      parentCode: null,
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "industry",
      code: "C901",
      name: "API开放品类",
      parentCode: "C900",
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "region",
      code: "110000",
      name: "API省",
      parentCode: null,
      ext: { level: 1, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110100",
      name: "API市",
      parentCode: "110000",
      ext: { level: 2, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110101",
      name: "API区",
      parentCode: "110100",
      ext: { level: 3, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "store_selling_point",
      code: "SP99",
      name: "API卖点",
      parentCode: null,
      ext: { categoryCodes: [] },
    },
  ])
    await prisma.dictItem.create({
      data: {
        ...item,
        id: uuidv7(),
        isEnabled: true,
        position: 999,
        createdAt: api.clock.now(),
        updatedAt: api.clock.now(),
      },
    });
}, 180000);
describe("商家档案十三条生产接口", () => {
  it("m.storeProfile.get 空档案现算不写库、计数端口默认0与店员裁剪", async () => {
    const ownerView = await data<StoreProfileOverview>(await request("m.storeProfile.get"));
    expect(ownerView).toMatchObject({
      viewerRole: "owner",
      completeness: { requiredTotal: 15 },
      store: { storeId, qualificationStatus: "unsubmitted" },
      members: { clerkCount: 0, pendingInvitationCount: 0 },
      assets: { total: 0, recent7dCount: 0 },
      ads: { confirmedCount: 0, pendingConfirmCount: 0, producingCount: 0, revisingCount: 0 },
    });
    expect(await prisma.storeProfile.count()).toBe(0);
    const response = await api.request("/api/v1/m/store-profile", {
      headers: clerk.withStore(storeId),
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const view = await data<Record<string, unknown>>(response);
    expect(view["viewerRole"]).toBe("clerk");
    expect(view).not.toHaveProperty("members.pendingInvitationCount");
    expect(view).not.toHaveProperty("entityName");
  });
  it("四步读写、手填执照、提交联动与脱敏重放", async () => {
    const before = await data<Record<string, unknown>>(await request("m.storeProfile.basic.get"));
    expect(before["lockVersion"]).toBe(0);
    const make = createFactories({ db: prisma, clock: api.clock });
    const file = (category = "profile_image") =>
      make.fileObject({
        category,
        bucket: category === "kyc_license" ? "secure" : "asset",
        scopeType: category === "kyc_license" ? "entity" : "store",
        entityId,
        storeId: category === "kyc_license" ? null : storeId,
        uploadActorType: "merchant",
        uploadActorId: owner.merchantUserId,
        uploadClient: "weapp",
      });
    const logo = await file(),
      photos = await Promise.all([file(), file(), file(), file()]);
    const body = {
      draft: false,
      lockVersion: 0,
      brandName: "API测试品牌",
      logoFileId: logo.id,
      storeName: "API测试门店",
      industryCode: "C900",
      categoryCode: "C901",
      address: {
        provinceCode: "110000",
        cityCode: "110100",
        districtCode: "110101",
        zoneCode: null,
        detail: "测试路一号",
        poiName: null,
        latitude: null,
        longitude: null,
      },
      businessHours: [{ start: "09:00", end: "18:00" }],
      storeTel: "010-12345678",
      avgSpendFen: 1000,
    };
    const key = uuidv7();
    expect(
      await data<Record<string, unknown>>(
        await request("m.storeProfile.basic.update", body, undefined, key),
      ),
    ).toMatchObject({ replayed: false, logo: { url: expect.any(String) } });
    const checks = api.wechat.callsOf("checkText").length;
    const replay = await request("m.storeProfile.basic.update", body, undefined, key);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data<Record<string, unknown>>(replay)).toMatchObject({
      replayed: true,
      logo: { url: null, expiresAt: null, coverUrl: null },
    });
    expect(api.wechat.callsOf("checkText")).toHaveLength(checks);
    await data(
      await request("m.storeProfile.media.update", {
        draft: false,
        lockVersion: 1,
        groups: {
          door: [{ fileId: photos[0]!.id }],
          interior: photos.slice(1).map((p) => ({ fileId: p.id })),
        },
      }),
    );
    expect(
      await data<Record<string, unknown>>(await request("m.storeProfile.media.get")),
    ).toMatchObject({ groups: { door: expect.any(Array), interior: expect.any(Array) } });
    await data(
      await request("m.storeProfile.service.update", {
        draft: false,
        lockVersion: 2,
        serviceItems: [{ name: "API服务", priceFen: 1000 }],
        sellingPointCodes: ["SP99"],
      }),
    );
    expect(
      await data<Record<string, unknown>>(await request("m.storeProfile.service.get")),
    ).toMatchObject({ serviceItems: [{ priceFen: 1000 }] });
    expect(
      await data<Record<string, unknown>>(
        await request("m.storeProfile.contact.update", {
          lockVersion: 3,
          name: "测试联系人",
          phoneSource: "login",
        }),
      ),
    ).toMatchObject({ phoneVerifyState: "login", phoneMask: expect.stringContaining("****") });
    const draft = await data<QualificationView>(
      await request("m.storeProfile.qualification.update", {
        lockVersion: null,
        claimedEntityType: "enterprise",
        declarationConfirmed: true,
        declarationVersion: "1",
      }),
    );
    const license = await file("kyc_license");
    const doc = await data<QualificationDocRecognized>(
      await request("m.qualificationDoc.create", {
        docType: "business_license",
        fileId: license.id,
      }),
    );
    expect(doc.recognized).toBeNull();
    expect(doc.doc.ocrStatus).toBe("unavailable");
    const fields = {
      name: "API认证主体",
      uscc: "91310000MA1K00001E",
      principal: "张测试",
      principalRole: "legal_rep",
      subjectType: "enterprise",
      validFrom: "2020-01-01",
      validTo: "long_term",
      address: "测试营业地址",
    };
    // 固定前17位，末位由统一校验算法算出（测试数据，不是真实号码）。
    const chars = "0123456789ABCDEFGHJKLMNPQRTUWXY",
      weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28],
      prefix = fields.uscc.slice(0, 17);
    fields.uscc =
      prefix +
      chars[
        (31 - ([...prefix].reduce((n, c, i) => n + chars.indexOf(c) * weights[i]!, 0) % 31)) % 31
      ];
    await data<QualificationDocUpdateResult>(
      await request(
        "m.qualificationDoc.update",
        { lockVersion: doc.lockVersion, fields },
        `/m/qualification-docs/${doc.doc.qualificationDocId}`,
      ),
    );
    const qview = await data<QualificationView>(await request("m.storeProfile.qualification.get"));
    expect(qview).toMatchObject({
      openRound: { docs: [{ certNoMask: expect.stringContaining("****") }] },
    });
    expect(JSON.stringify(qview)).not.toContain(fields.uscc);
    expect(JSON.stringify(qview)).not.toContain(fields.principal);
    if (draft.viewerRole !== "owner") throw new Error("老板请求须得到老板资质视图");
    await data(
      await request("m.storeProfile.qualification.submit", {
        qualificationSubmissionId: draft.openRound!.qualificationSubmissionId,
        declarationConfirmed: true,
        declarationVersion: "1",
      }),
    );
    expect(
      (await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).qualificationStatus,
    ).toBe("pending");
    expect(
      (await prisma.entity.findUniqueOrThrow({ where: { id: entityId } })).verificationStatus,
    ).toBe("pending");
  });
  it.each(routes.filter((row) => row[1] !== "GET"))(
    "店员 %s 写接口403，全部真实挂载",
    async (operationId, method, path) => {
      expect(HANDLERS.some((h) => h.route.operationId === operationId)).toBe(true);
      const response = await api.request(`/api/v1${path}`, {
        method,
        json: {},
        headers: { ...clerk.withStore(storeId), "Idempotency-Key": uuidv7() },
        peer: `198.19.109.${++peer}`,
      });
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.json()).toMatchObject({ error: "ROLE_FORBIDDEN" });
    },
  );
  it("当前会话openid只读且错配身份不能读取", async () => {
    const session = await prisma.userSession.findFirstOrThrow({
      where: { merchantUserId: owner.merchantUserId, revokedAt: null },
    });
    expect(session.wechatIdentityId).not.toBeNull();
    const principal = {
      sessionId: session.id,
      merchantUserId: owner.merchantUserId,
      wechatIdentityId: session.wechatIdentityId!,
      consentStamp: "test",
    };
    const identity = await prisma.wechatIdentity.findUniqueOrThrow({
      where: { id: session.wechatIdentityId! },
    });
    expect(await api.runtime.tx.run((tx) => currentSessionOpenid(tx, principal))).toBe(
      identity.openid,
    );
    await expect(
      api.runtime.tx.run((tx) =>
        currentSessionOpenid(tx, { ...principal, merchantUserId: clerk.merchantUserId }),
      ),
    ).rejects.toMatchObject({ error: "SESSION_INVALID" });
  });
});
