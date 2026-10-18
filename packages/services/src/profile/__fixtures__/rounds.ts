import { createIdentityContext } from "../../kernel/index.js";
import type { ProfileViewer } from "../context.js";
import { complete, ownedFile, submit, uscc } from "./harness.js";
import type { Harness } from "./harness.js";
export const reviewer = createIdentityContext({
  actor: { type: "system", job: "lyxtest.qualification_rounds" },
});
export async function qualified(h: Harness) {
  const world = await h.owner();
  const ready = await complete(h, world.viewer);
  await submit(h, world.viewer, ready.submissionId);
  await h.profile.approve(reviewer, ready.submissionId, {
    lockVersion: 0,
    confirm: { roundNo: 1 },
  });
  return { ...world, ready };
}
export async function newStoreReady(h: Harness, owner: ProfileViewer) {
  const store = await h.make.store({ entityId: owner.membership.entityId });
  const viewer = { ...owner, membership: { ...owner.membership, storeId: store.id } };
  await h.profile.updateBasic(viewer, {
    draft: false,
    lockVersion: 0,
    brandName: "多店测试品牌",
    storeName: "多店测试门店",
    industryCode: "C900",
    categoryCode: "C901",
    address: {
      provinceCode: "110000",
      cityCode: "110100",
      districtCode: "110101",
      zoneCode: null,
      detail: "测试路二号",
      poiName: null,
      latitude: null,
      longitude: null,
    },
    businessHours: [{ start: "09:00", end: "18:00" }],
    storeTel: "010-12345678",
    avgSpendFen: 10000,
  });
  const files = [];
  for (let n = 0; n < 4; n++) files.push(await ownedFile(h, viewer));
  await h.profile.updateMedia(viewer, {
    draft: false,
    lockVersion: 1,
    groups: {
      door: [{ fileId: files[0]!.id }],
      interior: files.slice(1).map((f) => ({ fileId: f.id })),
    },
  });
  await h.profile.updateService(viewer, {
    draft: false,
    lockVersion: 2,
    serviceItems: [{ name: "多店测试服务", priceFen: 1200 }],
    sellingPointCodes: ["SP99"],
  });
  await h.profile.updateContact(viewer, {
    lockVersion: 3,
    name: "新店联系人",
    phoneSource: "login",
  });
  const draft = await h.profile.updateQualification(viewer, { lockVersion: null });
  return { store, viewer, roundId: draft.openRound!.qualificationSubmissionId };
}
export const licenseFields = (number: string) => ({
  name: "变更后的测试主体",
  uscc: number,
  principal: "李测试",
  principalRole: "legal_rep",
  subjectType: "enterprise",
  validFrom: "2020-01-01",
  validTo: "long_term",
  address: "测试营业地址",
});
export async function replacementLicense(h: Harness, viewer: ProfileViewer, number = uscc()) {
  const file = await ownedFile(h, viewer, "kyc_license");
  const doc = await h.profile.createDocument(viewer, {
    docType: "business_license",
    fileId: file.id,
  });
  const updated = await h.profile.updateDocument(viewer, doc.doc.qualificationDocId, {
    lockVersion: doc.lockVersion,
    fields: licenseFields(number),
  });
  await h.profile.updateQualification(viewer, {
    lockVersion: updated.lockVersion,
    claimedEntityType: "enterprise",
  });
  return { ...doc, number };
}
export async function branchReady(h: Harness, viewer: ProfileViewer) {
  const file = await h.make.fileObject({
    category: "kyc_license",
    bucket: "secure",
    scopeType: "store",
    entityId: viewer.membership.entityId,
    storeId: viewer.membership.storeId,
    uploadActorType: "merchant",
    uploadActorId: viewer.principal.merchantUserId,
    uploadClient: "weapp",
  });
  const doc = await h.profile.createDocument(viewer, {
    docType: "branch_license",
    fileId: file.id,
  });
  await h.profile.updateDocument(viewer, doc.doc.qualificationDocId, {
    lockVersion: doc.lockVersion,
    fields: { ...licenseFields(uscc()), subjectType: "branch", principalRole: "branch_head" },
  });
  return doc;
}
export async function changeName(h: Harness, viewer: ProfileViewer, name = "变更后测试门店") {
  const basic = await h.profile.basic(viewer);
  return h.profile.updateBasic(viewer, {
    draft: true,
    lockVersion: basic.lockVersion,
    confirmReview: true,
    storeName: name,
  });
}
