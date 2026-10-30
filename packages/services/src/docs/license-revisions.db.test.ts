import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { latestLicenseRenderClaimLease, readLicenseRenderResults } from "../audit/index.js";
import { createIdentityContext } from "../kernel/index.js";
import { createLicenseConvergenceFixture, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { correctLicenseLetter, reconcileLetters, voidLicenseLetter } from "./license-convergence.js";
import type { LicenseConvergenceDeps, LicenseFacts } from "./license-facts.js";
import { claimLicenseRevision, completeLicenseRevision, failLicenseRevision,
  rerenderLicenseRevision, sweepLicenseRevisions } from "./license-queue.js";
import type { LicenseRenderClaim, LicenseRenderQueueDeps } from "./license-queue.js";
import { boundedLicenseRenderIssue } from "./license-render-result.js";

const db = useSeededDatabase("services", { max: 1 }), redis = useTestRedis();
type Fixture = Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
let active: Fixture | undefined;
afterEach(async () => { await active?.close(); active = undefined; });
const staff = createIdentityContext({ actor: { type: "system", job: "lyxtest.license_revision" }, requestId: "queue-tests" });
async function fresh() {
  const f = active = await createLicenseConvergenceFixture(await db.prisma(), {
    databaseUrl: await db.url(), redisUrl: process.env.REDIS_URL!, redisKeyPrefix: redis.prefix,
  });
  await f.start();
  await f.runtime.tx.run((tx) => reconcileLetters(tx, f.licenseDeps, [f.order.itemId], "test:revision"));
  return f;
}
const rows = async (f: Fixture) => (await db.prisma()).licenseLetter.findMany({
  where: { orderItemId: f.order.itemId }, orderBy: { id: "asc" },
  include: { revisions: { orderBy: { revNo: "asc" } } },
});
function queue(f: Fixture, convergence = f.licenseDeps): LicenseRenderQueueDeps {
  return {
    clock: f.clock, facts: convergence.facts, events: f.runtime.events,
    readLastClaimLease: latestLicenseRenderClaimLease,
    files: { async assertAndLink(tx, input) {
      const file = (await f.licenseDeps.readFiles(tx, [input.fileId]))[0];
      if (!file || file.sha256 !== input.sha256) throw new Error("测试文件哈希不一致");
      await f.runtime.media.link(tx, { fileId: input.fileId, refType: "license_letter_revision",
        refId: input.revisionId, role: "pdf", entityId: input.entityId, storeId: input.storeId });
    } },
  };
}
const renamed = (f: Fixture): LicenseConvergenceDeps => ({
  ...f.licenseDeps, snapshot: { ...f.licenseDeps.snapshot,
    licensee: async (tx, input) => ({ ...(await f.licenseDeps.snapshot.licensee(tx, input)), name: "技术联调主体更正" }),
  },
});
const altered = (f: Fixture, map: (v: LicenseFacts) => LicenseFacts): LicenseConvergenceDeps => ({
  ...f.licenseDeps, facts: { ...f.licenseDeps.facts,
    getLicenseFacts: async (tx, ids) => (await f.licenseDeps.facts.getLicenseFacts(tx, ids)).map(map),
  },
});
// Explicit owner-state transport fixture. Real PDF bytes/font/signature evidence belongs to license-render.test.ts.
async function uploaded(f: Fixture, claim: LicenseRenderClaim, suffix = "") {
  const body = Buffer.from(`%PDF-1.7\n% owner queue fixture ${claim.revisionId} ${suffix}\n%%EOF`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return f.runtime.media.putSystemFile({ category: "legal_doc", fileName: `${claim.letterNo}.pdf`,
    body, objectKey: `legal/${claim.orderItemId}/${claim.letterNo.toLowerCase()}-r${claim.revNo}-${sha256}.pdf`,
    entityId: claim.entityId, storeId: null,
  });
}
async function finish(f: Fixture, deps: LicenseRenderQueueDeps, claim: LicenseRenderClaim, suffix = "") {
  const file = await uploaded(f, claim, suffix);
  return f.runtime.tx.run((tx) => completeLicenseRevision(tx, deps, claim, {
    fileId: file.fileId, pdfSha256: file.sha256, signMode: "stamp", platformSignedAt: f.clock.now(),
  }));
}
const claimOne = async (f: Fixture, deps: LicenseRenderQueueDeps, id: string) => {
  const claim = await f.runtime.tx.run((tx) => claimLicenseRevision(tx, deps, id));
  expect(claim).not.toBeNull();
  return claim!;
};
const missing = { kind: "missing_glyph" as const, missing: [{ character: "𠮷", codePoint: "U+20BB7", fields: ["licensee.name"] }],
  totalMissingCodePoints: 1, truncated: false };

describe("授权版次owner、租约及不可变快照", { timeout: 120000 }, () => {
  it("更正比较最新版元数据，时钟前进仍拒绝无业务变化；新资料生成新版且旧快照保持", async () => {
    const f = await fresh(), letter = (await rows(f))[0]!, old = letter.revisions[0]!;
    f.clock.advance(60_000);
    const input = { licenseLetterId: letter.id, correctionKinds: ["licensee_name" as const], note: "资料已更新" };
    await expect(f.runtime.tx.run((tx) => correctLicenseLetter(tx, f.licenseDeps, staff, input)))
      .rejects.toMatchObject({ error: "LICENSE_LETTER_UNCHANGED" });
    const changed = await f.runtime.tx.run((tx) => correctLicenseLetter(tx, renamed(f), staff, input));
    expect(changed.revNo).toBe(2);
    const saved = (await rows(f)).find((v) => v.id === letter.id)!;
    expect(saved.revisions[0]).toEqual(old);
    expect(saved.revisions[1]).toMatchObject({ reason: "correction", renderStatus: "queued" });
    await expect(f.runtime.tx.run((tx) => correctLicenseLetter(tx, renamed(f), staff, input)))
      .rejects.toMatchObject({ error: "LICENSE_LETTER_UNCHANGED" });
    const staleLegal = altered(f, (fact) => ({ ...fact, usageEndDate: "2031-01-01" }));
    await expect(f.runtime.tx.run((tx) => correctLicenseLetter(tx, staleLegal, staff, input)))
      .rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
  });

  it("重复并发认领仅一路成功，文件引用与issued同事务且重放无副作用", async () => {
    const f = await fresh(), deps = queue(f), revision = (await rows(f))[0]!.revisions[0]!;
    const claimed = await Promise.all([0, 1].map(() => f.runtime.tx.run((tx) => claimLicenseRevision(tx, deps, revision.id))));
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const claim = claimed.find(Boolean)!;
    expect(claim.attempt).toBe(1);
    expect(await finish(f, deps, claim)).toBe(true);
    const prisma = await db.prisma(), ready = await prisma.licenseLetterRevision.findUniqueOrThrow({ where: { id: revision.id } });
    const letter = await prisma.licenseLetter.findUniqueOrThrow({ where: { id: claim.licenseLetterId } });
    expect(ready).toMatchObject({ renderStatus: "ready", signMode: "stamp", certIssuer: null, certSerial: null });
    expect(letter.currentRevisionId).toBe(ready.id);
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: ready.fileId! } })).toMatchObject({ sha256: ready.pdfSha256 });
    expect(await prisma.fileRef.count({ where: { refType: "license_letter_revision", refId: ready.id, role: "pdf" } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: "license_letter.issued", aggregateId: letter.id } })).toBe(1);
    expect(await finish(f, deps, claim)).toBe(false);
  });

  it("过期回收后旧认领上传迟到不得落库，新认领可ready", async () => {
    const f = await fresh(), deps = queue(f), revision = (await rows(f))[0]!.revisions[0]!;
    const first = await claimOne(f, deps, revision.id);
    f.clock.set(new Date(first.leaseUntil.getTime() + 1));
    const swept = await f.runtime.tx.run((tx) => sweepLicenseRevisions(tx, deps));
    expect(swept.requeue).toContainEqual({ revisionId: revision.id, attemptNo: 1 });
    const second = await claimOne(f, deps, revision.id);
    expect(second.attempt).toBe(2);
    expect(await finish(f, deps, first, "late")).toBe(false);
    expect(await finish(f, deps, second)).toBe(true);
  });

  it("对象已存而DB引用失败回滚ready；同认领重试提交成功且current不倒退", async () => {
    const f = await fresh(), deps = queue(f), letter = (await rows(f))[0]!;
    const first = await claimOne(f, deps, letter.revisions[0]!.id), file = await uploaded(f, first);
    const result = { fileId: file.fileId, pdfSha256: file.sha256, signMode: "stamp" as const, platformSignedAt: f.clock.now() };
    await expect(f.runtime.tx.run((tx) => completeLicenseRevision(tx, { ...deps,
      files: { assertAndLink: async () => { throw new Error("注入DB引用失败"); } },
    }, first, result))).rejects.toThrow("注入DB引用失败");
    expect(await (await db.prisma()).licenseLetterRevision.findUniqueOrThrow({ where: { id: first.revisionId } }))
      .toMatchObject({ renderStatus: "rendering", fileId: null, pdfSha256: null });
    expect(await (await db.prisma()).fileObject.findUnique({ where: { id: file.fileId } })).not.toBeNull();
    const next = await f.runtime.tx.run((tx) => correctLicenseLetter(tx, renamed(f), staff,
      { licenseLetterId: letter.id, correctionKinds: ["licensee_name"], note: "新资料" }));
    const second = await claimOne(f, deps, next.revisionId);
    expect(await finish(f, deps, second)).toBe(true);
    expect(await f.runtime.tx.run((tx) => completeLicenseRevision(tx, deps, first, result))).toBe(true);
    expect((await (await db.prisma()).licenseLetter.findUniqueOrThrow({ where: { id: letter.id } })).currentRevisionId)
      .toBe(second.revisionId);
  });

  it("缺字一次即failed且重启读诊断；同版人工重试清除，冻结时钟attempt归零仍不ABA", async () => {
    const f = await fresh(), deps = queue(f), letter = (await rows(f))[0]!, revision = letter.revisions[0]!;
    const first = await claimOne(f, deps, revision.id);
    expect(await f.runtime.tx.run((tx) => failLicenseRevision(tx, deps, first, missing))).toBe("failed");
    const persisted = await f.runtime.tx.run((tx) => readLicenseRenderResults(tx, { letterId: letter.id,
      entityId: letter.entityId, storeId: letter.storeId, revisionIds: [revision.id] }));
    expect(persisted.get(revision.id)?.issue).toEqual(missing);
    await f.runtime.tx.run((tx) => rerenderLicenseRevision(tx, deps, staff, { revisionId: revision.id }));
    const cleared = await f.runtime.tx.run((tx) => readLicenseRenderResults(tx, { letterId: letter.id,
      entityId: letter.entityId, storeId: letter.storeId, revisionIds: [revision.id] }));
    expect(cleared.get(revision.id)).toMatchObject({ outcome: "rerender", issue: null });
    const second = await claimOne(f, queue(f), revision.id);
    expect(second.attempt).toBe(1);
    expect(second.leaseUntil.getTime()).toBeGreaterThan(first.leaseUntil.getTime());
    expect(await finish(f, deps, first, "stale-cycle")).toBe(false);
    expect(await finish(f, deps, second)).toBe(true);
    expect((await f.runtime.tx.run((tx) => readLicenseRenderResults(tx, { letterId: letter.id,
      entityId: letter.entityId, storeId: letter.storeId, revisionIds: [revision.id] }))).get(revision.id))
      .toMatchObject({ outcome: "ready", issue: null });
    expect((await (await db.prisma()).licenseLetterRevision.findUniqueOrThrow({ where: { id: revision.id } })).letterSnapshot)
      .toEqual(revision.letterSnapshot);
  });

  it("四次租约耗尽后failed且current保持；仅failed能人工重试", async () => {
    const f = await fresh(), deps = queue(f), revision = (await rows(f))[0]!.revisions[0]!;
    await expect(f.runtime.tx.run((tx) => rerenderLicenseRevision(tx, deps, staff, { revisionId: revision.id })))
      .rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claim = await claimOne(f, deps, revision.id);
      expect(claim.attempt).toBe(attempt);
      f.clock.set(new Date(claim.leaseUntil.getTime() + 1));
      const result = await f.runtime.tx.run((tx) => sweepLicenseRevisions(tx, deps));
      if (attempt === 4) expect(result.failed).toContain(revision.id);
    }
    expect(await f.runtime.tx.run((tx) => claimLicenseRevision(tx, deps, revision.id))).toBeNull();
    expect(await (await db.prisma()).licenseLetterRevision.findUniqueOrThrow({ where: { id: revision.id } }))
      .toMatchObject({ renderStatus: "failed", renderAttemptNo: 4 });
    expect((await (await db.prisma()).licenseLetter.findUniqueOrThrow({ where: { id: revision.licenseLetterId } })).currentRevisionId).toBeNull();
  });

  it("人工作废同事务按真实账号重出；旧认领不能写ready，账号移出不重建", async () => {
    const f = await fresh(), deps = queue(f), letter = (await rows(f))[0]!;
    const claim = await claimOne(f, deps, letter.revisions[0]!.id);
    const result = await f.runtime.tx.run((tx) => voidLicenseLetter(tx, f.licenseDeps, staff,
      { licenseLetterId: letter.id, note: "技术联调作废并换发" }));
    expect(result.reissuedLicenseLetterId).not.toBeNull();
    expect(await finish(f, deps, claim)).toBe(false);
    const saved = await rows(f), old = saved.find((row) => row.id === letter.id)!;
    expect(old.status).toBe("voided");
    expect(old.revisions[0]!.renderStatus).toBe("failed");
    expect(saved.find((row) => row.id === result.reissuedLicenseLetterId)!.letterNo).toBe(`${letter.letterNo}-2`);
    const replacement = saved.find((row) => row.id === result.reissuedLicenseLetterId)!;
    const removed = altered(f, (fact) => ({ ...fact, accounts: fact.accounts.filter((a) => a.channelAccountId !== replacement.channelAccountId) }));
    expect(await f.runtime.tx.run((tx) => voidLicenseLetter(tx, removed, staff,
      { licenseLetterId: replacement.id, note: "当前账号已移出" }))).toMatchObject({ reissuedLicenseLetterId: null });
  });
});

it("缺字审计有界32码点/四字段/8KiB且去重，不用摘要冒充完整诊断", () => {
  const issue = boundedLicenseRenderIssue({ kind: "missing_glyph", missing: Array.from({ length: 100 }, (_, i) => ({
    character: String.fromCodePoint(0x20000 + i), codePoint: "ignored", fields: ["licensee.name", "drama.name", "account.name", "period.territory", "consent.by", "untrusted path"],
  })), totalMissingCodePoints: 100, truncated: false });
  expect(issue.missing).toHaveLength(32);
  expect(issue.missing.every((v) => v.fields.length === 4 && /^U\+[0-9A-F]+$/.test(v.codePoint))).toBe(true);
  expect(issue.truncated).toBe(true);
  expect(issue.totalMissingCodePoints).toBe(100);
  expect(Buffer.byteLength(JSON.stringify(issue), "utf8")).toBeLessThan(8192);
});
