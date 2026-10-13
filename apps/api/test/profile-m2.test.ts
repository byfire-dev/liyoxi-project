import { beforeAll, describe, expect, it } from "vitest";
import {
  mQualificationSubmissionList,
  mQualificationDocDownloadUrls,
  QualificationDocRemoveResultSchema,
  QualificationViewOwnerSchema,
} from "@liyoxi/contract";
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

// 后续多轮提交/审批尚未交付：以下new_store在审状态只作为符合正式约束的拒绝夹具。
let draftPeer = 0;
function draftRequest(
  path: string,
  session: SignedInMerchant,
  store: string,
  json?: unknown,
  key = uuidv7(),
) {
  return api.request(`/api/v1${path}`, {
    method: "POST",
    ...(json === undefined ? {} : { json }),
    headers: { ...session.withStore(store), "Idempotency-Key": key },
    peer: `198.19.211.${++draftPeer}`,
  });
}
async function expectError(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(((await response.json()) as { error: string }).error).toBe(error);
}
async function newDraft() {
  const prisma = await handle.db.prisma();
  const make = createFactories({ db: prisma, clock: api.clock });
  const draftOwner = await signInAsMerchant(api);
  const entity = await make.entity({
    verificationStatus: "verified",
    createdByUserId: draftOwner.merchantUserId,
  });
  const store = await make.store({ entityId: entity.id });
  await make.entityMember({
    entityId: entity.id,
    merchantUserId: draftOwner.merchantUserId,
    role: "owner",
  });
  const file = await make.fileObject({
    category: "kyc_license",
    bucket: "secure",
    scopeType: "store",
    entityId: entity.id,
    storeId: store.id,
    uploadActorType: "merchant",
    uploadActorId: draftOwner.merchantUserId,
    uploadClient: "weapp",
  });
  const created = await draftRequest("/m/qualification-docs", draftOwner, store.id, {
    fileId: file.id,
    docType: "branch_license",
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const result = (
    (await created.json()) as {
      data: {
        qualificationSubmissionId: string;
        lockVersion: number;
        doc: { qualificationDocId: string };
      };
    }
  ).data;
  return {
    owner: draftOwner,
    prisma,
    store,
    entity,
    file,
    roundId: result.qualificationSubmissionId,
    id: result.doc.qualificationDocId,
    version: result.lockVersion,
  };
}

describe("W2-11 商家资质草稿写接口", () => {
  it("m.qualificationDoc.remove 初次草稿可移除且required幂等重放只写一次", async () => {
    expect(HANDLERS.some((h) => h.route.operationId === "m.qualificationDoc.remove")).toBe(true);
    const prisma = await handle.db.prisma();
    const key = uuidv7();
    const path = `/m/qualification-docs/${docId}/remove`;
    const first = await draftRequest(path, owner, storeId, undefined, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const data = QualificationDocRemoveResultSchema.parse(
      ((await first.json()) as { data: unknown }).data,
    );
    expect(data).toMatchObject({
      qualificationDocId: docId,
      removedAt: api.clock.now().toISOString(),
    });
    const before = await prisma.auditLog.count({
      where: { targetId: docId, action: "profile.document.remove" },
    });
    const replay = await draftRequest(path, owner, storeId, undefined, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await replay.json()) as { data: unknown }).data).toEqual(data);
    expect(
      await prisma.auditLog.count({
        where: { targetId: docId, action: "profile.document.remove" },
      }),
    ).toBe(before);
    await expectError(await draftRequest(path, owner, storeId), 409, "STATE_NOT_ALLOWED");
    expect(
      await prisma.fileRef.findFirstOrThrow({
        where: { refType: "qualification_doc", refId: docId },
      }),
    ).toMatchObject({
      state: "released",
      keepUntil: new Date(api.clock.now().getTime() + 7 * 86400000),
    });
  });

  it("m.qualificationDoc.remove new_store公开上传再移除，跨主体不枚举证照", async () => {
    const w = await newDraft();
    await expectError(
      await draftRequest(`/m/qualification-docs/${w.id}/remove`, foreign, foreignStoreId),
      404,
      "NOT_FOUND",
    );
    const result = await draftRequest(`/m/qualification-docs/${w.id}/remove`, w.owner, w.store.id);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(
      QualificationDocRemoveResultSchema.parse(((await result.json()) as { data: unknown }).data),
    ).toMatchObject({ qualificationSubmissionId: w.roundId, lockVersion: w.version + 1 });
    expect(
      await w.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: w.id } }),
    ).toMatchObject({ removedAt: api.clock.now(), verdict: null, effectiveAt: null });
  });

  it("m.storeProfile.qualification.discard 丢弃new_store并重放；新草稿不能被旧id或旧键误丢", async () => {
    expect(
      HANDLERS.some((h) => h.route.operationId === "m.storeProfile.qualification.discard"),
    ).toBe(true);
    const w = await newDraft(),
      key = uuidv7();
    const body = { qualificationSubmissionId: w.roundId };
    const path = "/m/store-profile/qualification/discard";
    const first = await draftRequest(path, w.owner, w.store.id, body, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const value = QualificationViewOwnerSchema.parse(
      ((await first.json()) as { data: unknown }).data,
    );
    expect(value.openRound).toBeNull();
    const audits = await w.prisma.auditLog.count({
      where: { targetId: w.roundId, action: "profile.qualification.discard" },
    });
    expect(
      await w.prisma.fileRef.findFirstOrThrow({
        where: { refType: "qualification_doc", refId: w.id },
      }),
    ).toMatchObject({ state: "released" });
    const next = await api.request("/api/v1/m/store-profile/qualification", {
      method: "PATCH",
      json: { lockVersion: null },
      headers: { ...w.owner.withStore(w.store.id), "Idempotency-Key": uuidv7() },
    });
    expect(next.status, await next.clone().text()).toBe(200);
    const newRound = QualificationViewOwnerSchema.parse(
      ((await next.json()) as { data: unknown }).data,
    ).openRound!;
    const replay = await draftRequest(path, w.owner, w.store.id, body, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await replay.json()) as { data: unknown }).data).toEqual(value);
    await expectError(
      await draftRequest(path, w.owner, w.store.id, body),
      409,
      "STATE_NOT_ALLOWED",
    );
    expect(
      await w.prisma.qualificationSubmission.findUniqueOrThrow({
        where: { id: newRound.qualificationSubmissionId },
      }),
    ).toMatchObject({ closedAt: null, submittedAt: null });
    expect(
      await w.prisma.auditLog.count({
        where: { targetId: w.roundId, action: "profile.qualification.discard" },
      }),
    ).toBe(audits);
  });

  it("m.storeProfile.qualification.discard 初次草稿拒绝，缺失/陌生/跨主体id拒绝且零业务写", async () => {
    const prisma = await handle.db.prisma();
    const initial = await prisma.qualificationSubmission.findFirstOrThrow({
      where: { storeId, closedAt: null },
    });
    const before = await prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: initial.id },
    });
    await expectError(
      await draftRequest("/m/store-profile/qualification/discard", owner, storeId, {
        qualificationSubmissionId: initial.id,
      }),
      409,
      "STATE_NOT_ALLOWED",
    );
    await expectError(
      await draftRequest("/m/store-profile/qualification/discard", owner, storeId, {}),
      400,
      "VALIDATION_FAILED",
    );
    await expectError(
      await draftRequest("/m/store-profile/qualification/discard", owner, storeId, {
        qualificationSubmissionId: uuidv7(),
      }),
      409,
      "STATE_NOT_ALLOWED",
    );
    await expectError(
      await draftRequest("/m/store-profile/qualification/discard", foreign, foreignStoreId, {
        qualificationSubmissionId: initial.id,
      }),
      409,
      "STATE_NOT_ALLOWED",
    );
    expect(
      await prisma.qualificationSubmission.findUniqueOrThrow({ where: { id: initial.id } }),
    ).toEqual(before);
  });

  it("m.qualificationDoc.remove / m.storeProfile.qualification.discard 店员真实鉴权403，缺幂等键400", async () => {
    const prisma = await handle.db.prisma();
    const initial = await prisma.qualificationSubmission.findFirstOrThrow({
      where: { storeId, closedAt: null },
    });
    for (const [path, body] of [
      [`/m/qualification-docs/${docId}/remove`, undefined],
      ["/m/store-profile/qualification/discard", { qualificationSubmissionId: initial.id }],
    ] as const) {
      await expectError(await draftRequest(path, clerk, storeId, body), 403, "ROLE_FORBIDDEN");
      const missing = await api.request(`/api/v1${path}`, {
        method: "POST",
        ...(body ? { json: body } : {}),
        headers: owner.withStore(storeId),
      });
      expect(missing.status).toBe(400);
    }
  });

  it("m.qualificationDoc.remove / m.storeProfile.qualification.discard 在审拒绝且审批/文件引用不变", async () => {
    const w = await newDraft(),
      now = api.clock.now();
    const approval = await w.prisma.approvalRequest.create({
      data: {
        id: uuidv7(),
        kind: "qualification",
        category: "review",
        subjectType: "store",
        subjectId: w.store.id,
        entityId: w.entity.id,
        storeId: w.store.id,
        roundNo: 1,
        status: "pending",
        summarySnapshot: { title: "在审拒绝夹具" },
        submitActorType: "merchant",
        submitActorId: w.owner.merchantUserId,
        submitClient: "weapp",
        submittedAt: now,
        dedupeKey: `qualification:${w.store.id}`,
        createdAt: now,
        updatedAt: now,
      },
    });
    await w.prisma.qualificationSubmission.update({
      where: { id: w.roundId },
      data: {
        roundNo: 1,
        proposedStoreName: w.store.name,
        proposedIndustryCode: "C900",
        proposedCategoryCode: "C901",
        proposedAddressSnapshot: { detail: "在审地址" },
        declarationConfirmedAt: now,
        declarationVersion: "1",
        submittedAt: now,
        submittedByUserId: w.owner.merchantUserId,
        approvalRequestId: approval.id,
      },
    });
    const before = await w.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: w.roundId },
    });
    await expectError(
      await draftRequest(`/m/qualification-docs/${w.id}/remove`, w.owner, w.store.id),
      409,
      "QUALIFICATION_IN_REVIEW",
    );
    await expectError(
      await draftRequest("/m/store-profile/qualification/discard", w.owner, w.store.id, {
        qualificationSubmissionId: w.roundId,
      }),
      409,
      "QUALIFICATION_IN_REVIEW",
    );
    expect(
      await w.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id: w.roundId } }),
    ).toEqual(before);
    expect(
      await w.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toEqual(approval);
    expect(
      await w.prisma.fileRef.findFirstOrThrow({
        where: { refType: "qualification_doc", refId: w.id },
      }),
    ).toMatchObject({ state: "live" });
    expect(
      await w.prisma.auditLog.count({
        where: {
          storeId: w.store.id,
          action: { in: ["profile.document.remove", "profile.qualification.discard"] },
        },
      }),
    ).toBe(0);
  });
});
