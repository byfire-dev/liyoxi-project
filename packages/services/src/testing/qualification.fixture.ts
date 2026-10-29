// Shared qualification prerequisites: fixture files/dictionaries plus real profile public commands.
// These helpers create upstream test facts, never approval outcomes or cancellation inputs.
import type { PrismaClient } from "@liyoxi/db";
import { uuidv7 } from "../kernel/index.js";
import type { Clock } from "../kernel/index.js";
import type { Profile, ProfileViewer } from "../profile/index.js";
import type { Factories } from "./data/index.js";

export interface QualificationFixture {
  readonly prisma: Pick<PrismaClient, "dictItem">;
  readonly clock: Pick<Clock, "now">;
  readonly make: Pick<Factories, "fileObject">;
  readonly profile: Pick<
    Profile,
    | "updateBasic"
    | "updateMedia"
    | "updateService"
    | "updateContact"
    | "updateQualification"
    | "createDocument"
    | "updateDocument"
    | "submit"
  >;
}

const CHARS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
let sequence = 0;
export function createQualificationFixtureUscc() {
  const prefix = `91310000MA1K${String(++sequence).padStart(5, "0")}`;
  const sum = [...prefix].reduce((n, c, i) => n + CHARS.indexOf(c) * WEIGHTS[i]!, 0);
  return prefix + CHARS[(31 - (sum % 31)) % 31];
}
export async function installQualificationFixtureDicts(
  h: Pick<QualificationFixture, "prisma" | "clock">,
) {
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
export async function createQualificationFixtureFile(
  h: Pick<QualificationFixture, "make">,
  viewer: ProfileViewer,
  category = "profile_image",
) {
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
export async function completeQualificationFixture(
  h: QualificationFixture,
  viewer: ProfileViewer,
  number = createQualificationFixtureUscc(),
) {
  await installQualificationFixtureDicts(h);
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
  for (let i = 0; i < 4; i++) files.push(await createQualificationFixtureFile(h, viewer));
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
  const file = await createQualificationFixtureFile(h, viewer, "kyc_license");
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
export async function submitQualificationFixture(
  h: { readonly profile: Pick<Profile, "submit"> },
  viewer: ProfileViewer,
  submissionId: string,
) {
  return h.profile.submit(viewer, {
    qualificationSubmissionId: submissionId,
    declarationConfirmed: true,
    declarationVersion: "1",
  });
}
