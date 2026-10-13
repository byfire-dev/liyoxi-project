import { expect, it } from "vitest";
import {
  QualificationDocRecognizedSchema,
  QualificationSubmissionDetailSchema,
  QualificationViewOwnerSchema,
} from "@liyoxi/contract";
import { createIdentityContext, runSeed, security, uuidv7 } from "@liyoxi/services";
import type { ProfileViewer } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { FakeOcr, FakeStorage } from "@liyoxi/services/testing";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi, TEST_API_KEYRING } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { complete, harness, ownedFile, uscc } from "./admin-profile-fixtures.js";

const handle = useTestApi();
it("同步识别真实HTTP：独立证据、脱敏重放、权限、人工更正与批准闭环", async () => {
  const api = await handle.start({ qualificationOcr: true });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  const owner = await signInAsMerchant(api),
    foreign = await signInAsMerchant(api),
    tenant = merchantServicesOf(api.runtime).tenant;
  const identity = (id: string) =>
    createIdentityContext({ actor: { type: "merchant", id, client: "weapp" } });
  const own = await tenant.createEntity(identity(owner.merchantUserId)),
    other = await tenant.createEntity(identity(foreign.merchantUserId)),
    prisma = await handle.db.prisma(),
    h = harness(api, prisma),
    ocr = api.runtime.providers.ocr as FakeOcr,
    storage = api.runtime.providers.storage as FakeStorage;
  const viewer: ProfileViewer = {
    ctx: identity(owner.merchantUserId),
    principal: {
      sessionId: owner.merchantUserId,
      merchantUserId: owner.merchantUserId,
      wechatIdentityId: owner.merchantUserId,
      consentStamp: "test",
    },
    membership: {
      memberId: own.memberId,
      entityId: own.entityId,
      storeId: own.storeId,
      role: "owner",
      storeMode: "active",
    },
  };
  // 仅准备前三步和手填草稿；新证照、送审、更正、批准均由下方真实HTTP产生。
  ocr.failNext("recognizeBusinessLicense");
  await complete(h, viewer);
  const number = uscc();
  ocr.defaultLicense = {
    name: "W316虚构识别主体",
    uscc: number,
    principal: "虚构甲",
    subjectType: "enterprise",
    validFrom: "2020-01-01",
    validTo: "long_term",
    address: "虚构营业地址",
    warnings: ["WARN_COPY_CARD"],
    raw: JSON.stringify({ RegNum: number, Person: "虚构甲" }),
  };
  const file = await ownedFile(h, viewer, "kyc_license");
  storage.put(
    { bucket: "secure", key: file.objectKey },
    new Uint8Array([255, 216, 255]),
    "image/jpeg",
  );
  let peer = 0;
  const request = (
    path: string,
    method = "GET",
    json?: unknown,
    headers = owner.withStore(own.storeId),
    key = uuidv7(),
  ) =>
    api.request(`/api/v1/${path}`, {
      method,
      ...(json === undefined ? {} : { json }),
      headers: { ...headers, "Idempotency-Key": key },
      peer: `198.19.216.${++peer}`,
    });
  const data = async (response: Response, privateRead = false) => {
    expect(response.status, await response.clone().text()).toBe(200);
    if (privateRead) expect(response.headers.get("Cache-Control")).toBe("no-store");
    return ((await response.json()) as { data: unknown }).data;
  };
  const body = { fileId: file.id, docType: "business_license" },
    key = uuidv7();
  const first = QualificationDocRecognizedSchema.parse(
    await data(await request("m/qualification-docs", "POST", body, undefined, key)),
  );
  expect(first).toMatchObject({
    replayed: false,
    doc: { ocrStatus: "ok", ocrWarnings: ["WARN_COPY_CARD"] },
    recognized: { uscc: number, principal: "虚构甲", subjectType: "enterprise" },
    entityTypeCheck: { isMismatch: false },
  });
  expect(first.submitted).toEqual(first.recognized);
  const stored = await prisma.qualificationDoc.findUniqueOrThrow({
    where: { id: first.doc.qualificationDocId },
  });
  const evidence = await prisma.ocrResult.findUniqueOrThrow({ where: { id: stored.ocrResultId! } });
  expect(evidence.fieldsEnc).not.toContain(number);
  expect(security.decryptField(TEST_API_KEYRING, "ocr_result.raw_enc", evidence.rawEnc!)).toContain(
    number,
  );
  const calls = ocr.calls.length;
  const replayResponse = await request("m/qualification-docs", "POST", body, undefined, key);
  expect(replayResponse.headers.get("Idempotent-Replayed")).toBe("true");
  expect(QualificationDocRecognizedSchema.parse(await data(replayResponse))).toMatchObject({
    recognized: null,
    submitted: null,
    replayed: true,
    doc: { ocrStatus: "ok" },
  });
  const idem = await prisma.idempotencyRecord.findFirstOrThrow({ where: { key } });
  expect(idem.result).toMatchObject({ recognized: null, submitted: null });
  expect(JSON.stringify(idem.result)).not.toContain(number);
  expect(JSON.stringify(idem.result)).not.toContain("虚构甲");
  expect(ocr.calls).toHaveLength(calls);
  expect(await prisma.ocrResult.count({ where: { fileId: file.id } })).toBe(1);
  const view = QualificationViewOwnerSchema.parse(
    await data(await request("m/store-profile/qualification"), true),
  );
  expect(view.openRound?.qualificationSubmissionId).toBe(first.qualificationSubmissionId);
  const path = `m/qualification-docs/${stored.id}/download-urls`;
  const signed: unknown[] = [];
  for (let n = 0; n < 2; n++) signed.push(await data(await request(path, "POST", {}), true));
  expect(signed[0]).not.toEqual(signed[1]);
  const denied = await request(path, "POST", {}, foreign.withStore(other.storeId));
  expect(denied.status).toBe(404);
  expect(ocr.calls).toHaveLength(calls);
  await data(
    await request("m/store-profile/qualification/submit", "POST", {
      qualificationSubmissionId: first.qualificationSubmissionId,
      declarationConfirmed: true,
      declarationVersion: "1",
    }),
  );
  const reviewer = await signInAsStaff(prisma, { roleKey: "super_admin" });
  const adminPath = `admin/qualification-submissions/${first.qualificationSubmissionId}`;
  const detail = QualificationSubmissionDetailSchema.parse(
    await data(await request(adminPath, "GET", undefined, reviewer.headers)),
  );
  expect(detail.docs[0]?.fieldChecks.some((c) => c.code === "C7")).toBe(true);
  const corrected = QualificationSubmissionDetailSchema.parse(
    await data(
      await request(
        `admin/qualification-docs/${stored.id}`,
        "PATCH",
        {
          lockVersion: detail.lockVersion,
          fields: { name: "W316虚构人工核对主体" },
          note: "虚构原图核对",
        },
        reviewer.headers,
      ),
    ),
  );
  expect(corrected.docs[0]).toMatchObject({ isCorrected: true, ocrStatus: "ok" });
  expect(corrected.docs[0]?.fieldChecks.some((c) => c.code === "C6")).toBe(true);
  const approved = QualificationSubmissionDetailSchema.parse(
    await data(
      await request(
        `${adminPath}/approve`,
        "POST",
        {
          lockVersion: corrected.approval.lockVersion,
          confirm: { roundNo: corrected.approval.roundNo },
        },
        reviewer.headers,
      ),
    ),
  );
  expect(approved).toMatchObject({ outcome: "approved", approveMode: "corrected" });
  expect(await prisma.ocrResult.findUniqueOrThrow({ where: { id: evidence.id } })).toEqual(
    evidence,
  );
  expect(
    (await prisma.qualificationDoc.findUniqueOrThrow({ where: { id: stored.id } }))
      .submittedFieldsEnc,
  ).toBe(stored.submittedFieldsEnc);
}, 60_000);
