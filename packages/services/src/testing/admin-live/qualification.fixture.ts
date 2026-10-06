import { createDocs } from "../../docs/index.js";
import { createIdentity, currentSessionOpenid } from "../../identity/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { createProfile } from "../../profile/index.js";
import type { ProfileViewer } from "../../profile/index.js";
import { loadKeyring } from "../../security/index.js";
import { createTenant } from "../../tenant/index.js";
import { createFakeWechat } from "../providers/index.js";
import type { AdminLiveFixture } from "./context.js";

const chars = "0123456789ABCDEFGHJKLMNPQRTUWXY",
  weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
function fakeUscc(index: number) {
  const prefix = `91310000MA9X${String(index).padStart(5, "0")}`;
  const sum = [...prefix].reduce(
    (total, character, i) => total + chars.indexOf(character) * weights[i]!,
    0,
  );
  return prefix + chars[(31 - (sum % 31)) % 31];
}
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  const { tx, clock, assembly, flow, events, config } = runtime;
  const keyring = loadKeyring(runtime.env),
    tenant = createTenant({ tx, clock, assembly, flow });
  const wechat = createFakeWechat();
  const docs = createDocs({ tx, clock });
  const identity = createIdentity({
    tx,
    clock,
    assembly,
    flow,
    events,
    config,
    docs,
    tenant,
    keyring: () => keyring,
    wechat,
    appid: "wx0000000000000000",
  });
  const profile = createProfile({
    tx,
    clock,
    assembly,
    events,
    tenant,
    approval: runtime.approval,
    media: runtime.media,
    keyring: () => keyring,
    wechat,
    currentOpenid: (principal) => tx.run((db) => currentSessionOpenid(db, principal)),
  });
  const staff = await tx.run((db) =>
    db.staff.findFirstOrThrow({ where: { staffRoleKey: "super_admin", status: "active" } }),
  );
  const legal = await make.fileObject({ category: "legal_doc", bucket: "secure", ext: "pdf" });
  const consents = [];
  for (const agreementKey of ["user", "privacy"]) {
    const agreement = await make.agreementVersion({
      agreementKey,
      createdByStaffId: staff.id,
      pdfFileId: legal.id,
    });
    consents.push({ agreementKey, agreementVersionId: agreement.id });
  }
  for (const item of [
    {
      dictTypeKey: "industry",
      code: "C990",
      name: "演练开放行业",
      parentCode: null,
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "industry",
      code: "C991",
      name: "演练开放品类",
      parentCode: "C990",
      ext: { open: true, special: false, requiredCerts: [] },
    },
    {
      dictTypeKey: "region",
      code: "110000",
      name: "演练省",
      parentCode: null,
      ext: { level: 1, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110100",
      name: "演练市",
      parentCode: "110000",
      ext: { level: 2, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "region",
      code: "110101",
      name: "演练区",
      parentCode: "110100",
      ext: { level: 3, functionalZone: false, opened: true },
    },
    {
      dictTypeKey: "store_selling_point",
      code: "SP99",
      name: "演练特色",
      parentCode: null,
      ext: { categoryCodes: [] },
    },
  ])
    await tx.run((db) =>
      db.dictItem.upsert({
        where: { dictTypeKey_code: { dictTypeKey: item.dictTypeKey, code: item.code } },
        create: {
          ...item,
          id: uuidv7(),
          isEnabled: true,
          position: 999,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
        update: {},
      }),
    );
  const submissions = [];
  for (let index = 1; index <= 3; index++) {
    const code = `lyxtest-profile-${index}`;
    wechat.sessions.set(code, { openid: `${code}-openid` });
    wechat.phones.set(code, `1870000999${index}`);
    const login = await identity.phoneLogin(
      {
        requestId: code,
        ip: "127.0.0.1",
        userAgent: "lyxtest admin live",
        clientVersion: "admin-live-fixtures",
      },
      { loginCode: code, phoneCode: code, consents },
    );
    const userId = login.me.user.merchantUserId;
    const ctx = createIdentityContext({
      actor: { type: "merchant", id: userId, client: "weapp" },
      requestId: code,
    });
    const membership = await tenant.createEntity(ctx);
    const principal = await identity.authenticate(login.token, { ip: "127.0.0.1" });
    if (!principal.ok) throw new Error("演练商家会话创建失败");
    const viewer: ProfileViewer = {
      ctx,
      principal: principal.principal,
      membership: { ...membership, role: "owner", storeMode: "active" },
    };
    const claimed = await profile.updateQualification(viewer, {
      lockVersion: null,
      claimedEntityType: "enterprise",
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    const submissionId = claimed.openRound!.qualificationSubmissionId;
    const headers = { authorization: `Bearer ${login.token}`, "X-Store-Id": membership.storeId };
    if (index === 3) {
      submissions.push({
        submissionId,
        storeId: membership.storeId,
        name: "演练缺项",
        headers,
        incomplete: true,
      });
      continue;
    }
    const name = index === 1 ? "演练青柠咖啡" : "演练邻里小店";
    await profile.updateBasic(viewer, {
      draft: false,
      lockVersion: 0,
      brandName: "演练品牌",
      storeName: name,
      industryCode: "C990",
      categoryCode: "C991",
      address: {
        provinceCode: "110000",
        cityCode: "110100",
        districtCode: "110101",
        zoneCode: null,
        detail: "演练路一号",
        poiName: null,
        latitude: null,
        longitude: null,
      },
      businessHours: [{ start: "09:00", end: "18:00" }],
      storeTel: "010-12345678",
      avgSpendFen: 2800,
    });
    const files = [];
    for (let i = 0; i < 4; i++)
      files.push(
        await make.fileObject({
          category: "profile_image",
          bucket: "asset",
          scopeType: "store",
          entityId: membership.entityId,
          storeId: membership.storeId,
          uploadActorType: "merchant",
          uploadActorId: userId,
          uploadClient: "weapp",
        }),
      );
    await profile.updateMedia(viewer, {
      draft: false,
      lockVersion: 1,
      groups: {
        door: [{ fileId: files[0]!.id }],
        interior: files.slice(1).map((file) => ({ fileId: file.id })),
      },
    });
    await profile.updateService(viewer, {
      draft: false,
      lockVersion: 2,
      serviceItems: [{ name: "演练套餐", priceFen: 2800 }],
      sellingPointCodes: ["SP99"],
    });
    await profile.updateContact(viewer, {
      lockVersion: 3,
      name: "演练联系人",
      phoneSource: "login",
    });
    const license = await make.fileObject({
      category: "kyc_license",
      bucket: "secure",
      scopeType: "entity",
      entityId: membership.entityId,
      uploadActorType: "merchant",
      uploadActorId: userId,
      uploadClient: "weapp",
    });
    const document = await profile.createDocument(viewer, {
      fileId: license.id,
      docType: "business_license",
    });
    await profile.updateDocument(viewer, document.doc.qualificationDocId, {
      lockVersion: document.lockVersion,
      fields: {
        name: `${name}演练主体`,
        uscc: fakeUscc(index),
        principal: "张演练",
        principalRole: "legal_rep",
        subjectType: "enterprise",
        validFrom: "2020-01-01",
        validTo: "long_term",
        address: "演练营业地址",
      },
    });
    // 第二单留作浏览器实际提交：先验证过期声明拒绝，再用当前版本提交进入队列。
    if (index === 1)
      await profile.submit(viewer, {
        qualificationSubmissionId: submissionId,
        declarationConfirmed: true,
        declarationVersion: "1",
      });
    submissions.push({
      submissionId,
      storeId: membership.storeId,
      name,
      docId: document.doc.qualificationDocId,
      fileId: license.id,
      headers,
      incomplete: false,
    });
  }
  return { submissions };
};
export default fixture;
