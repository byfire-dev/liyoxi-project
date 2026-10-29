import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { M4Support } from "@liyoxi/services/testing";
import type { M1Api } from "./in-process.js";
import type { M1AuthenticatedStaff } from "./m1-auth.js";
import { createM1Caller } from "./runner-api.js";
import type { M1Result } from "./runner-api.js";
const image = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
    "base64",
  ),
);
export { image as m4Image };
// 虚构统一社会信用代码；完整校验位，避免把单包的跳过校验夹具带入主链。
function fakeUscc() {
  const prefix = "91310000MA1K00001",
    chars = "0123456789ABCDEFGHJKLMNPQRTUWXY";
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  return (
    prefix +
    chars[
      (31 -
        ([...prefix].reduce((sum, char, i) => sum + chars.indexOf(char) * weights[i]!, 0) % 31)) %
        31
    ]
  );
}
export async function prepareM4Merchant(
  api: M1Api,
  support: M4Support,
  actors: { admin: M1AuthenticatedStaff; reviewer: Pick<M1AuthenticatedStaff, "staffId"> },
) {
  const call = createM1Caller(api),
    admin = actors.admin.headers;
  const step = async <T>(_name: string, run: () => Promise<T>) => run();
  const owner = await step("商家真实手机号登录、协议与主体门店", async () => {
    const agreements = await call("m.agreement.list", {}, { query: { scene: "login" } });
    const consents = agreements.items
      .filter((a) => a.subjectKind === "user" && a.currentVersion)
      .map((a) => ({
        agreementKey: a.agreementKey,
        agreementVersionId: a.currentVersion!.agreementVersionId,
      }));
    assert.equal(consents.length, 2);
    const loginCode = `m4-login-${support.runId}`,
      phoneCode = `m4-phone-${support.runId}`;
    {
      support.providers.wechat.sessions.set(loginCode, { openid: `oM1_${support.runId}` });
      support.providers.wechat.phones.set(phoneCode, "13700000121");
    }
    const login = await call(
      "m.session.phoneLogin",
      {},
      { body: { loginCode, phoneCode, consents } },
    );
    const userHeaders = {
      authorization: `Bearer ${login.token}`,
      "X-Client-Version": "1.0.0",
      "X-Client-Platform": "android",
    };
    await call("m.bootstrap.get", userHeaders);
    // 同意走实际公开接口，不能仅在测试数据库补记录。
    await call("m.agreementConsent.create", userHeaders, { body: { consents } });
    const membership = await call("m.entity.create", userHeaders, { body: {} });
    assert.equal(membership.role, "owner");
    const headers = { ...userHeaders, "X-Store-Id": membership.storeId };
    const stores = await call("m.store.list", headers);
    assert.ok(stores.items.some((s) => s.storeId === membership.storeId));
    await support.drainEvents();
    const state = await support.readState(membership);
    assert.equal(state.store.qualificationStatus, "unsubmitted");
    assert.equal(state.wallet?.heldTotalQty, 0);
    return { ...membership, merchantUserId: login.me.user.merchantUserId, headers };
  });
  const headers = owner.headers;
  async function upload(
    registration: Pick<M1Result<"admin.file.create">, "mode" | "post" | "key" | "expiresAt">,
    bytes: Uint8Array,
  ) {
    assert.equal(registration.mode, "post");
    assert.ok(registration.post, "本轮实际存储必须签发直传表单");
    assert.equal(
      await support.providers.storage.upload(
        {
          ...registration.post,
          key: registration.key,
          expiresAt: new Date(registration.expiresAt),
        },
        bytes,
      ),
      204,
      "实际表单直传必须成功",
    );
  }
  async function merchantFile(
    category: "profile_image" | "kyc_license" | "channel_screenshot" | "pay_receipt",
  ) {
    const registrations = await call("m.file.create", headers, {
      body: {
        category,
        ...(category === "kyc_license" ? { licenseKind: "business_license" as const } : {}),
        files: [
          {
            fileName: `${category}-${randomUUID()}.png`,
            sizeBytes: String(image.length),
            clientToken: randomUUID(),
          },
        ],
      },
    });
    const file = registrations.items[0];
    assert.ok(file);
    await upload(file, image);
    const complete = () =>
      call("m.file.complete", headers, { body: {}, params: { fileId: file.fileId } });
    if (support.completeWithPromote) await support.completeWithPromote(file.fileId, complete);
    else await complete();
    await support.promote(file.fileId);
    assert.equal(
      (await call("m.file.get", headers, { params: { fileId: file.fileId } })).status,
      "stored",
    );
    return file.fileId;
  }
  await step("四步建档、真实资质审核通过与交付经理指派", async () => {
    const logoFileId = await merchantFile("profile_image"),
      photos: string[] = [];
    for (let i = 0; i < 4; i++) photos.push(await merchantFile("profile_image"));
    const defaults = support.profileDefaults;
    const basic = await call("m.storeProfile.basic.get", headers);
    assert.equal(basic.viewerRole, "owner");
    const saved = await call("m.storeProfile.basic.update", headers, {
      body: {
        draft: false,
        lockVersion: basic.lockVersion,
        brandName: "M4演示品牌",
        logoFileId,
        storeName: `M4演示门店-${support.runId}`,
        industryCode: defaults.industryCode,
        categoryCode: defaults.categoryCode,
        address: { ...defaults.address },
        businessHours: [{ start: "09:00", end: "18:00" }],
        storeTel: "010-12345678",
        avgSpendFen: 10000,
      },
    });
    const media = await call("m.storeProfile.media.update", headers, {
      body: {
        draft: false,
        lockVersion: saved.lockVersion,
        groups: {
          door: [{ fileId: photos[0]! }],
          interior: photos.slice(1).map((fileId) => ({ fileId })),
        },
      },
    });
    const service = await call("m.storeProfile.service.update", headers, {
      body: {
        draft: false,
        lockVersion: media.lockVersion,
        serviceItems: [{ name: "门店标准服务", priceFen: 10000 }],
        sellingPointCodes: [...defaults.sellingPointCodes],
      },
    });
    await call("m.storeProfile.contact.update", headers, {
      body: { lockVersion: service.lockVersion, name: "演示联系人", phoneSource: "login" },
    });
    const draft = await call("m.storeProfile.qualification.update", headers, {
      body: { lockVersion: null, claimedEntityType: "enterprise" },
    });
    assert.equal(draft.viewerRole, "owner");
    if (draft.viewerRole !== "owner") throw new Error("资质必须为老板视图");
    assert.ok(draft.openRound);
    const licenseFileId = await merchantFile("kyc_license");
    const doc = await call("m.qualificationDoc.create", headers, {
      body: { docType: "business_license", fileId: licenseFileId },
    });
    await call("m.qualificationDoc.update", headers, {
      params: { qualificationDocId: doc.doc.qualificationDocId },
      body: {
        lockVersion: doc.lockVersion,
        fields: {
          name: "M4演示经营主体",
          uscc: fakeUscc(),
          principal: "演示负责人",
          principalRole: "legal_rep",
          subjectType: "enterprise",
          validFrom: "2020-01-01",
          validTo: "long_term",
          address: "演示路一号",
        },
      },
    });
    const submitted = await call("m.storeProfile.qualification.submit", headers, {
      body: {
        qualificationSubmissionId: draft.openRound.qualificationSubmissionId,
        declarationConfirmed: true,
        declarationVersion: "1",
      },
    });
    assert.equal(submitted.storeQualificationStatus, "pending");
    const pending = await support.readState(owner);
    assert.equal(pending.store.qualificationStatus, "pending");
    const queue = await call("admin.approval.list", admin, {
      query: { kind: "qualification", storeId: owner.storeId },
    });
    assert.ok(queue.items.some((a) => a.domain.id === draft.openRound!.qualificationSubmissionId));
    const view = await call("admin.qualificationSubmission.get", admin, {
      params: { qualificationSubmissionId: draft.openRound.qualificationSubmissionId },
    });
    await call("admin.qualificationSubmission.approve", admin, {
      params: { qualificationSubmissionId: view.qualificationSubmissionId },
      body: {
        lockVersion: view.approval.lockVersion,
        mode: "normal",
        confirm: { roundNo: view.roundNo! },
        confirmChecks: view.confirmChecks,
      },
    });
    await call("admin.store.assignDeliveryManager", admin, {
      params: { storeId: owner.storeId },
      body: { toStaffId: actors.reviewer.staffId },
    });
    await support.drainEvents();
    const state = await support.readState(owner);
    assert.equal(state.entity.verificationStatus, "verified");
    assert.equal(state.store.qualificationStatus, "verified");
    assert.equal(state.store.deliveryManagerId, actors.reviewer.staffId);
    assert.equal(state.qualifications.filter((q) => q.outcome === "approved").length, 1);
  });
  return { ...owner, merchantFile };
}
