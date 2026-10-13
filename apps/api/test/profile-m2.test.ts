import { beforeAll, describe, expect, it } from "vitest";
import { mQualificationSubmissionList, mQualificationDocDownloadUrls } from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import { merchantServicesOf } from "../src/merchant/services.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
const handle = useTestApi();
let api: TestApi, owner: SignedInMerchant, clerk: SignedInMerchant, foreign: SignedInMerchant;
let storeId: string, foreignStoreId: string, docId: string;
const records =
  mQualificationSubmissionList.responses[200].content["application/json"].schema.shape.data;
const signedUrl =
  mQualificationDocDownloadUrls.responses[200].content["application/json"].schema.shape.data;
beforeAll(async () => {
  api = await handle.start();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  const entity = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  storeId = entity.storeId;
  const make = createFactories({ db: await handle.db.prisma(), clock: api.clock });
  clerk = await signInAsMerchant(api);
  const member = await make.entityMember({
    entityId: entity.entityId,
    merchantUserId: clerk.merchantUserId,
  });
  await make.storeMember({ storeId, entityMemberId: member.id, addedByMemberId: entity.memberId });
  foreign = await signInAsMerchant(api);
  foreignStoreId = (
    await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: foreign.merchantUserId, client: "weapp" },
      }),
    )
  ).storeId;
  const file = await make.fileObject({
    category: "kyc_license",
    bucket: "secure",
    scopeType: "entity",
    entityId: entity.entityId,
    storeId: null,
    uploadActorType: "merchant",
    uploadActorId: owner.merchantUserId,
    uploadClient: "weapp",
  });
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "secure", key: file.objectKey },
    new Uint8Array([255, 216, 255]),
    "image/jpeg",
  );
  const created = await api.request("/api/v1/m/qualification-docs", {
    method: "POST",
    json: { docType: "business_license", fileId: file.id },
    headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  docId = ((await created.json()) as { data: { doc: { qualificationDocId: string } } }).data.doc
    .qualificationDocId;
}, 180000);
describe("W2-11仅两条资质读接口", () => {
  it("m.qualificationSubmission.list 真实owner空历史成功、过滤草稿且no-store", async () => {
    expect(
      HANDLERS.some((entry) => entry.route.operationId === "m.qualificationSubmission.list"),
    ).toBe(true);
    const response = await api.request("/api/v1/m/qualification-submissions?limit=1", {
      headers: owner.withStore(storeId),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(records.parse(((await response.json()) as { data: unknown }).data)).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    const invalid = await api.request("/api/v1/m/qualification-submissions?cursor=not-json", {
      headers: owner.withStore(storeId),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toBe("VALIDATION_FAILED");
  });
  it("m.qualificationSubmission.list clerk真实鉴权拒绝；外主体X-Store-Id不能读取", async () => {
    const response = await api.request("/api/v1/m/qualification-submissions", {
      headers: clerk.withStore(storeId),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("ROLE_FORBIDDEN");
    const foreignResponse = await api.request("/api/v1/m/qualification-submissions", {
      headers: foreign.withStore(storeId),
    });
    expect(foreignResponse.status).toBe(403);
  });
  it("m.qualificationDoc.downloadUrls 每次现签5分钟并访问留痕，零幂等回放", async () => {
    expect(
      HANDLERS.some((entry) => entry.route.operationId === "m.qualificationDoc.downloadUrls"),
    ).toBe(true);
    const prisma = await handle.db.prisma(),
      before = await prisma.auditLog.count({
        where: { targetId: docId, action: "profile.document.url.sign" },
      });
    const urls = [];
    for (let n = 0; n < 2; n++) {
      const response = await api.request(`/api/v1/m/qualification-docs/${docId}/download-urls`, {
        method: "POST",
        json: {},
        headers: owner.withStore(storeId),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const value = signedUrl.parse(((await response.json()) as { data: unknown }).data);
      urls.push(value.url);
      expect(new Date(value.expiresAt).getTime() - api.clock.now().getTime()).toBe(300_000);
      expect((api.runtime.providers.storage as FakeStorage).fetch(value.url).status).toBe(200);
    }
    expect(urls[0]).not.toBe(urls[1]);
    expect(
      await prisma.auditLog.count({
        where: { targetId: docId, action: "profile.document.url.sign" },
      }),
    ).toBe(before + 2);
  });
  it("m.qualificationDoc.downloadUrls clerk403、外主体404与注入fileId400均零签名", async () => {
    const storage = api.runtime.providers.storage as FakeStorage,
      count = storage.callsOf("presignGet").length;
    const forbidden = await api.request(`/api/v1/m/qualification-docs/${docId}/download-urls`, {
      method: "POST",
      json: {},
      headers: clerk.withStore(storeId),
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: string }).error).toBe("ROLE_FORBIDDEN");
    const foreignResponse = await api.request(
      `/api/v1/m/qualification-docs/${docId}/download-urls`,
      { method: "POST", json: {}, headers: foreign.withStore(foreignStoreId) },
    );
    expect(foreignResponse.status).toBe(404);
    const injection = await api.request(`/api/v1/m/qualification-docs/${docId}/download-urls`, {
      method: "POST",
      json: { fileId: uuidv7() },
      headers: owner.withStore(storeId),
    });
    expect(injection.status).toBe(400);
    expect(storage.callsOf("presignGet")).toHaveLength(count);
  });
});
