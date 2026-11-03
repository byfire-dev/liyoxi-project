import { afterAll, beforeAll, expect, it } from "vitest";
import { LicenseVerificationQuerySchema, LicenseVerificationViewSchema } from "@liyoxi/contract";
import { createIdentityContext } from "../kernel/index.js";
import { createLicenseConvergenceFixture, snapshotTables, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { correctLicenseLetter, reconcileLetters, voidLicenseLetter } from "./license-convergence.js";
import { claimLicenseRevision, completeLicenseRevision } from "./license-queue.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";
import { createLicenseVerification } from "./license-verification.js";

const db = useSeededDatabase("services", { max: 1 }), redis = useTestRedis();
const tables = ["license_letter", "license_letter_revision", "file_object", "file_ref", "audit_log", "outbox_event", "status_transition", "timer"];
const system = createIdentityContext({ actor: { type: "system", job: "lyxtest.license_verify" } });
let h: Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
let verify: ReturnType<typeof createLicenseVerification>;
let letterId: string, code: string, firstRevisionId: string;
beforeAll(async () => {
  h = await createLicenseConvergenceFixture(await db.prisma(), { databaseUrl: await db.url(), redisUrl: process.env.REDIS_URL!, redisKeyPrefix: redis.prefix });
  verify = createLicenseVerification({ tx: h.runtime.tx, clock: h.clock });
});
beforeAll(async () => { await h.start(); });
beforeAll(async () => {
  await h.runtime.tx.run((tx) => reconcileLetters(tx, h.licenseDeps, [h.order.itemId], "test:portal-verification"));
  const row = await (await db.prisma()).licenseLetter.findFirstOrThrow({ where: { orderItemId: h.order.itemId }, include: { revisions: true }, orderBy: { id: "asc" } });
  letterId = row.id; code = row.verifyCode; firstRevisionId = row.revisions[0]!.id;
});
afterAll(async () => { await h?.close(); });

async function finish(revisionId: string) {
  const claim = await h.runtime.tx.run((tx) => claimLicenseRevision(tx, h.runtime.docsRender.queue, revisionId));
  if (!claim) throw new Error("授权验真测试没有实际认领版次");
  // Owner-state transport only. These bytes do not claim typography, signature or legal acceptance.
  const file = await h.runtime.media.putSystemFile({ category: "legal_doc", fileName: "verification.pdf",
    body: Buffer.from(`%PDF-1.7\n% verification state transport ${revisionId}\n%%EOF`),
    objectKey: `legal/verification/${revisionId}.pdf`, entityId: claim.entityId, storeId: null });
  expect(await h.runtime.tx.run((tx) => completeLicenseRevision(tx, h.runtime.docsRender.queue, claim, {
    fileId: file.fileId, pdfSha256: file.sha256, signMode: "stamp", platformSignedAt: h.clock.now(),
  }))).toBe(true);
}
async function correct(name: string) {
  return h.runtime.tx.run((tx) => correctLicenseLetter(tx, {
    ...h.licenseDeps, snapshot: { ...h.licenseDeps.snapshot,
      licensee: async (inner, input) => ({ ...(await h.licenseDeps.snapshot.licensee(inner, input)), name }),
    },
  }, system, { licenseLetterId: letterId, correctionKinds: ["licensee_name"], note: "验真脱敏测试资料更正" }));
}

it("坏码、不存在码和未出件信件均404，所有查询包括拒绝均零写", async () => {
  const p = await db.prisma(), before = await snapshotTables(p, tables);
  for (const value of ["bad-code", "0".repeat(16), code])
    await expect(verify.get({ code: value })).rejects.toMatchObject({ error: "LICENSE_VERIFICATION_NOT_FOUND" });
  expect(await snapshotTables(p, tables)).toEqual(before);
  for (const revNo of ["abc", "1.5", "0", "-1", "", "Infinity", "1e2"])
    expect(LicenseVerificationQuerySchema.parse({ code, revNo }).revNo).toBeUndefined();
  expect(LicenseVerificationQuerySchema.parse({ code, revNo: "2" }).revNo).toBe(2);
});

it("真实claim/上传/完成后公开验真只投影出件版及hash，敏感内部标识与PDF地址不出境", async () => {
  await finish(firstRevisionId);
  const p = await db.prisma(), row = await p.licenseLetterRevision.findUniqueOrThrow({ where: { id: firstRevisionId } });
  const snapshot = parseLicenseLetterSnapshot(row.letterSnapshot), before = await snapshotTables(p, tables);
  const value = await verify.get({ code, revNo: 1 });
  expect(value).toMatchObject({ requestedRevisionState: "current", requestedRevNo: 1,
    hasPendingRevision: false, currentRevision: { revNo: 1, signMode: "stamp", certSerial: null, pdfSha256: row.pdfSha256, contentFp: row.contentFp },
    revisions: [{ revNo: 1, isCurrent: true, pdfSha256: row.pdfSha256 }],
    consent: { operatorMask: snapshot.consent.by },
  });
  const serialized = JSON.stringify(value);
  for (const secret of [letterId, firstRevisionId, row.fileId!, snapshot.verifyUrl, snapshot.licensee.creditCode, snapshot.licensee.name])
    expect(serialized).not.toContain(secret);
  for (const key of ["verifyUrl", "url", "fileId", "entityId", "storeId", "voidReason", "letterSnapshot", "licenseLetterId"])
    expect(value).not.toHaveProperty(key);
  expect(LicenseVerificationViewSchema.safeParse({ ...value, pdfUrl: "https://example.invalid/private.pdf" }).success).toBe(false);
  expect(await snapshotTables(p, tables)).toEqual(before);
});

it("待生成新版保持当前快照与proof；完成后旧版只剩已出件proof，非法版号按原协议处理", async () => {
  const changed = await correct("技术联调主体更正");
  expect((await verify.get({ code, revNo: changed.revNo })).requestedRevisionState).toBe("not_found");
  expect((await verify.get({ code })).hasPendingRevision).toBe(true);
  expect((await verify.get({ code })).currentRevision.revNo).toBe(1);
  await finish(changed.revisionId);
  const p = await db.prisma(), before = await snapshotTables(p, tables);
  const value = await verify.get({ code, revNo: 1 });
  expect(value).toMatchObject({ licenseeNameMask: "技术**主体更正", currentRevision: { revNo: 2 },
    requestedRevisionState: "outdated", hasPendingRevision: false,
    revisions: [{ revNo: 2, isCurrent: true }, { revNo: 1, isCurrent: false }],
  });
  expect((await verify.get({ code, revNo: 999 })).requestedRevisionState).toBe("not_found");
  expect((await verify.get(LicenseVerificationQuerySchema.parse({ code, revNo: "bad" })))).toMatchObject({ requestedRevisionState: "not_requested", requestedRevNo: null });
  expect(await snapshotTables(p, tables)).toEqual(before);
});

it("短名称仅留首字；真实作废仍能核对出件版，作废原因不公开且不写验真访问", async () => {
  const changed = await correct("测试店");
  await finish(changed.revisionId);
  expect((await verify.get({ code })).licenseeNameMask).toBe("测**");
  await h.runtime.tx.run((tx) => voidLicenseLetter(tx, h.licenseDeps, system, { licenseLetterId: letterId, note: "验真测试内部原因" }));
  const p = await db.prisma(), before = await snapshotTables(p, tables);
  const value = await verify.get({ code });
  expect(value).toMatchObject({ displayStatus: "voided", voidedAt: h.clock.now().toISOString(), currentRevision: { revNo: 3 } });
  expect(JSON.stringify(value)).not.toContain("验真测试内部原因");
  expect(await snapshotTables(p, tables)).toEqual(before);
});
