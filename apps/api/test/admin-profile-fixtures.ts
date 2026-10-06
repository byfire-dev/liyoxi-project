// API 夹具仅经 services 公共出口装配，业务请求走生产鉴权链。
import { createProfile, createIdentityContext, uuidv7 } from "@liyoxi/services";
import type { ProfileViewer } from "@liyoxi/services";
import { createFactories, TEST_KEYRING } from "@liyoxi/services/testing";
import { merchantServicesOf } from "../src/merchant/services.js";
import { TEST_API_KEYRING } from "../src/testing/index.js";
import type { TestApi, TestApiHandle } from "../src/testing/index.js";
export function harness(api: TestApi, prisma: Awaited<ReturnType<TestApiHandle["db"]["prisma"]>>) {
  const { tx, clock, assembly, approval, events, media, providers } = api.runtime,
    make = createFactories({ db: prisma, clock });
  const keyring = {
    currentKid: TEST_API_KEYRING.currentKid,
    kids: [...TEST_API_KEYRING.kids, ...TEST_KEYRING.kids],
    dataKey: (kid: string) => TEST_API_KEYRING.dataKey(kid) ?? TEST_KEYRING.dataKey(kid),
    bidxKey: TEST_API_KEYRING.bidxKey,
  };
  const profile = createProfile({
    tx,
    clock,
    assembly,
    approval,
    events,
    media,
    tenant: merchantServicesOf(api.runtime).tenant,
    keyring: () => keyring,
    wechat: providers.wechat,
    currentOpenid: async () => "lyxtest_profile_openid",
  });
  async function owner() {
    const user = await make.merchantUser(),
      entity = await make.entity({ createdByUserId: user.id }),
      store = await make.store({ entityId: entity.id, isPrimary: true }),
      member = await make.entityMember({
        entityId: entity.id,
        merchantUserId: user.id,
        role: "owner",
      });
    const viewer: ProfileViewer = {
      ctx: createIdentityContext({
        actor: { type: "merchant", id: user.id, client: "weapp" },
        requestId: "req_profile",
      }),
      principal: {
        sessionId: user.id,
        merchantUserId: user.id,
        wechatIdentityId: user.id,
        consentStamp: "test",
      },
      membership: {
        memberId: member.id,
        entityId: entity.id,
        storeId: store.id,
        role: "owner",
        storeMode: "active",
      },
    };
    return { user, entity, store, member, viewer };
  }
  return { prisma, tx, clock, make, profile, owner };
}
export type Harness = ReturnType<typeof harness>;
const CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
let sequence = 0;
export function uscc() {
  const prefix = `91310000MA1K${String(++sequence).padStart(5, "0")}`;
  const sum = [...prefix].reduce((n, c, i) => n + CHARS.indexOf(c) * WEIGHTS[i]!, 0);
  return prefix + CHARS[(31 - (sum % 31)) % 31];
}
export async function installDicts(h: Harness) {
  for (const item of [
    {
      dictTypeKey: "industry",
      code: "C900",
      name: "测试开放行业",
      parentCode: null,
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "industry",
      code: "C901",
      name: "测试开放品类",
      parentCode: "C900",
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "region",
      code: "110000",
      name: "测试省",
      parentCode: null,
      ext: { level: 1, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110100",
      name: "测试市",
      parentCode: "110000",
      ext: { level: 2, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110101",
      name: "测试区",
      parentCode: "110100",
      ext: { level: 3, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "store_selling_point",
      code: "SP99",
      name: "测试卖点",
      parentCode: null,
      ext: { categoryCodes: [] },
    },
  ])
    await h.prisma.dictItem.upsert({
      where: { dictTypeKey_code: { dictTypeKey: item.dictTypeKey, code: item.code } },
      create: {
        ...item,
        id: uuidv7(),
        isEnabled: true,
        position: 999,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
      update: {},
    });
}
export async function ownedFile(h: Harness, viewer: ProfileViewer, category = "profile_image") {
  return h.make.fileObject({
    category,
    bucket: category.startsWith("kyc") ? "secure" : "asset",
    scopeType: category === "kyc_license" ? "entity" : "store",
    entityId: viewer.membership.entityId,
    storeId: category === "kyc_license" ? null : viewer.membership.storeId,
    uploadActorType: "merchant",
    uploadActorId: viewer.principal.merchantUserId,
    uploadClient: "weapp",
  });
}
export async function complete(h: Harness, viewer: ProfileViewer, number = uscc()) {
  await installDicts(h);
  await h.profile.updateBasic(viewer, {
    draft: false,
    lockVersion: 0,
    brandName: "测试品牌",
    storeName: "测试门店",
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
    avgSpendFen: 10000,
  });
  const files = [];
  for (let i = 0; i < 4; i++) files.push(await ownedFile(h, viewer));
  await h.profile.updateMedia(viewer, {
    draft: false,
    lockVersion: 1,
    groups: {
      door: [{ fileId: files[0]!.id }],
      interior: files.slice(1).map((file) => ({ fileId: file.id })),
    },
  });
  await h.profile.updateService(viewer, {
    draft: false,
    lockVersion: 2,
    serviceItems: [{ name: "测试服务", priceFen: 1000 }],
    sellingPointCodes: ["SP99"],
  });
  await h.profile.updateContact(viewer, {
    lockVersion: 3,
    name: "测试联系人",
    phoneSource: "login",
  });
  const q = await h.profile.updateQualification(viewer, {
    lockVersion: null,
    claimedEntityType: "enterprise",
    declarationConfirmed: true,
    declarationVersion: "1",
  });
  const file = await ownedFile(h, viewer, "kyc_license");
  const created = await h.profile.createDocument(viewer, {
    fileId: file.id,
    docType: "business_license",
  });
  await h.profile.updateDocument(viewer, created.doc.qualificationDocId, {
    lockVersion: created.lockVersion,
    fields: {
      name: "测试认证主体",
      uscc: number,
      principal: "张测试",
      principalRole: "legal_rep",
      subjectType: "enterprise",
      validFrom: "2020-01-01",
      validTo: "long_term",
      address: "测试营业地址",
    },
  });
  return {
    submissionId: q.openRound!.qualificationSubmissionId,
    docId: created.doc.qualificationDocId,
    number,
  };
}
export async function submit(h: Harness, viewer: ProfileViewer, submissionId: string) {
  return h.profile.submit(viewer, {
    qualificationSubmissionId: submissionId,
    declarationConfirmed: true,
    declarationVersion: "1",
  });
}
