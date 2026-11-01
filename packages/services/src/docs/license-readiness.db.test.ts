import { afterEach, expect, it } from "vitest";
import { createIdentityContext } from "../kernel/index.js";
import { createLicenseConvergenceFixture, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { correctLicenseLetter } from "./license-convergence.js";
import { claimLicenseRevision, completeLicenseRevision } from "./license-queue.js";
import { readLicenseReadiness } from "./license-readiness.js";

const db = useSeededDatabase("services", { max: 1 }), redis = useTestRedis();
let active: Awaited<ReturnType<typeof createLicenseConvergenceFixture>> | undefined;
afterEach(async () => { await active?.close(); active = undefined; });

it("交付授权要求全部当前账号和最新真实ready版；新排队版、错归属及失效文件均不放行", { timeout: 120_000 }, async () => {
  const prisma = await db.prisma();
  const f = active = await createLicenseConvergenceFixture(prisma, {
    databaseUrl: await db.url(), redisUrl: process.env.REDIS_URL!, redisKeyPrefix: redis.prefix,
  });
  await f.start();
  const readMaterialFileFacts = f.readFilesForReadiness;
  const ready = () => f.runtime.tx.run((tx) => f.runtime.licenseLetters.ensureLicenseReadiness(tx, [f.order.itemId], "test:delivery-ready"));
  // The blocked caller's rollback also rolls back newly queued letters; it does not enqueue work magically.
  await expect(f.runtime.tx.run(async (tx) => {
    const result = await f.runtime.licenseLetters.ensureLicenseReadiness(tx, [f.order.itemId], "test:rollback");
    expect(result[0]?.ready).toBe(false);
    throw new Error("blocked-package-rollback");
  })).rejects.toThrow("blocked-package-rollback");
  expect(await prisma.licenseLetter.count({ where: { orderItemId: f.order.itemId } })).toBe(0);
  expect(await ready()).toEqual([{ orderItemId: f.order.itemId, ready: false, blockers: ["revision_pending"] }]);
  const rows = () => prisma.licenseLetter.findMany({ where: { orderItemId: f.order.itemId },
    include: { revisions: { orderBy: { revNo: "desc" } } }, orderBy: { id: "asc" } });
  const finish = async (revisionId: string) => {
    const claim = await f.runtime.tx.run((tx) => claimLicenseRevision(tx, f.runtime.docsRender.queue, revisionId));
    expect(claim).not.toBeNull();
    // Owner-state transport fixture only; actual PDF typography/signature validation belongs to W5-07.
    const body = Buffer.from(`%PDF-1.7\n% readiness transport ${revisionId}\n%%EOF`);
    const file = await f.runtime.media.putSystemFile({ category: "legal_doc", fileName: "readiness.pdf",
      body, objectKey: `legal/readiness/${revisionId}.pdf`, entityId: claim!.entityId, storeId: null });
    expect(await f.runtime.tx.run((tx) => completeLicenseRevision(tx, f.runtime.docsRender.queue, claim!, {
      fileId: file.fileId, pdfSha256: file.sha256, signMode: "stamp", platformSignedAt: f.clock.now(),
    }))).toBe(true);
  };
  const letters = await rows();
  expect(letters).toHaveLength(2);
  await finish(letters[0]!.revisions[0]!.id);
  expect((await ready())[0]?.ready).toBe(false);
  await finish(letters[1]!.revisions[0]!.id);
  expect(await ready()).toEqual([{ orderItemId: f.order.itemId, ready: true, blockers: [] }]);
  const letter = (await rows())[0]!;
  const revised = await f.runtime.tx.run((tx) => correctLicenseLetter(tx, {
    ...f.licenseDeps, snapshot: { ...f.licenseDeps.snapshot,
      licensee: async (tx, input) => ({ ...(await f.licenseDeps.snapshot.licensee(tx, input)), name: "技术测试名称更正" }),
    },
  }, createIdentityContext({ actor: { type: "system", job: "lyxtest.readiness" } }), {
    licenseLetterId: letter.id, correctionKinds: ["licensee_name"], note: "新版测试资料",
  }));
  expect(revised.revNo).toBe(2);
  expect((await prisma.licenseLetter.findUniqueOrThrow({ where: { id: letter.id } })).currentRevisionId).toBe(letter.currentRevisionId);
  expect((await ready())[0]).toMatchObject({ ready: false, blockers: ["revision_pending"] });
  await finish((await rows()).find((row) => row.id === letter.id)!.revisions[0]!.id);
  expect((await ready())[0]?.ready).toBe(true);
  await f.runtime.tx.run(async (tx) => {
    const facts = await f.licenseDeps.facts.getLicenseFacts(tx, [f.order.itemId]);
    const wrongScope = await readLicenseReadiness(tx, facts.map((fact) => ({ ...fact, storeId: f.merchant.entity.id })), readMaterialFileFacts);
    expect(wrongScope[0]).toMatchObject({ ready: false, blockers: ["legal_mismatch"] });
    const removed = await readLicenseReadiness(tx, facts, async (tx, ids) => (await readMaterialFileFacts(tx, ids)).map((file) => ({ ...file, deletedAt: f.clock.now() })));
    expect(removed[0]).toMatchObject({ ready: false, blockers: ["file_not_ready"] });
    const mismatch = await readLicenseReadiness(tx, facts, async (tx, ids) => (await readMaterialFileFacts(tx, ids)).map((file) => ({ ...file, sha256: "0".repeat(64) })));
    expect(mismatch[0]).toMatchObject({ ready: false, blockers: ["file_not_ready"] });
  });
});
