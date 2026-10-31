import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { latestLicenseRenderClaimLease } from "../audit/index.js";
import { SYSTEM_SCOPE, ownTaskScope } from "../authz/index.js";
import {
  claimLicenseRevision,
  completeLicenseRevision,
  createLicensePdfRenderer,
  reconcileLetters,
} from "../docs/index.js";
import type { LicenseRenderQueueDeps } from "../docs/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import { uuidv7 } from "../kernel/index.js";
import {
  assertSnapshotsEqual,
  createLicenseConvergenceFixture,
  createTestLicenseTemplateCatalog,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { MONEY_TABLES, REQUEST_TABLES, requestsHarness } from "./__fixtures__/cancel-requests.js";
import { body, drama } from "./__fixtures__/harness.js";
import { readOrderAfterSales } from "./cancel-read.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

describe("W5-07订单售后及授权书真实owner投影", { timeout: 120000 }, () => {
  it("真实queued/ready授权书读入订单，文件哈希及current对应；只读不改变领域或账本", async () => {
    const f = await createLicenseConvergenceFixture(await db.prisma(), {
      databaseUrl: await db.url(),
      redisUrl: process.env.REDIS_URL!,
      redisKeyPrefix: redis.prefix,
    });
    closers.push(f.close);
    await f.start();
    await f.runtime.tx.run((tx) =>
      reconcileLetters(tx, f.licenseDeps, [f.order.itemId], "test:order-projection"),
    );
    const letters = await (
      await db.prisma()
    ).licenseLetter.findMany({
      where: { orderItemId: f.order.itemId },
      include: { revisions: true },
      orderBy: { id: "asc" },
    });
    const pending = await f.runtime.order.adminGet(SYSTEM_SCOPE, f.order.id);
    expect(pending.licenseLetterCount).toBe(2);
    expect(pending.licenseLetters.every((row) => row.currentRevision === null)).toBe(true);
    const renderer = createLicensePdfRenderer({
      fontDir: resolve(import.meta.dirname, "../../../../infra/docker/server/fonts"),
      catalog: createTestLicenseTemplateCatalog(),
    });
    closers.push(() => renderer.close());
    const deps: LicenseRenderQueueDeps = {
      ...f.licenseDeps,
      readLastClaimLease: latestLicenseRenderClaimLease,
      files: {
        async assertAndLink(tx, input) {
          const [file] = await readMaterialFileFacts(tx, [input.fileId]);
          if (file?.sha256 !== input.sha256) throw new Error("实际PDF文件哈希不一致");
          await f.runtime.media.link(tx, {
            fileId: input.fileId,
            refType: "license_letter_revision",
            refId: input.revisionId,
            role: "pdf",
            entityId: input.entityId,
            storeId: input.storeId,
          });
        },
      },
    };
    const claim = await f.runtime.tx.run((tx) =>
      claimLicenseRevision(tx, deps, letters[0]!.revisions[0]!.id),
    );
    expect(claim).not.toBeNull();
    const rendered = await renderer.render({
      snapshot: claim!.snapshot,
      contentFingerprint: claim!.contentFp,
      templateVersion: claim!.templateVersion,
    });
    if (!rendered.ok) throw new Error(`实际技术样张未渲染：${rendered.reason}`);
    expect(Buffer.from(rendered.value.pdf).subarray(0, 5).toString()).toBe("%PDF-");
    const hash = createHash("sha256").update(rendered.value.pdf).digest("hex");
    const file = await f.runtime.media.putSystemFile({
      category: "legal_doc",
      entityId: claim!.entityId,
      storeId: null,
      body: rendered.value.pdf,
      fileName: `${claim!.letterNo}.pdf`,
      objectKey: `legal/${claim!.licenseLetterId}/${hash}.pdf`,
    });
    expect(
      await f.runtime.tx.run((tx) =>
        completeLicenseRevision(tx, deps, claim!, {
          fileId: file.fileId,
          pdfSha256: hash,
          signMode: "stamp",
          platformSignedAt: f.clock.now(),
        }),
      ),
    ).toBe(true);
    const prisma = await db.prisma(),
      before = await snapshotTables(prisma, [
        ...REQUEST_TABLES,
        "license_letter",
        "license_letter_revision",
      ]);
    const merchant = await f.runtime.order.get(f.actor, f.order.id),
      admin = await f.runtime.order.adminGet(SYSTEM_SCOPE, f.order.id);
    expect(merchant.licenseLetters.map((row) => row.licenseLetterId).sort()).toEqual(
      letters.map((row) => row.id).sort(),
    );
    expect(admin.licenseLetterCount).toBe(2);
    expect(
      admin.licenseLetters.find((row) => row.licenseLetterId === claim!.licenseLetterId)
        ?.currentRevision,
    ).toMatchObject({
      licenseLetterRevisionId: claim!.revisionId,
      renderStatus: "ready",
      fileId: file.fileId,
    });
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).sha256).toBe(
      hash,
    );
    assertSnapshotsEqual(
      before,
      await snapshotTables(prisma, [
        ...REQUEST_TABLES,
        "license_letter",
        "license_letter_revision",
      ]),
    );
  });

  it("真实申请关闭与实际执行记录回填，未执行去向为空、执行后取真实账本值，范围外不可读", async () => {
    const h = requestsHarness(await db.prisma());
    closers.push(h.close);
    const p = await h.atStage("pending_start");
    await h.param("refund.points.auto_approve_before_production", false, p.actor);
    const first = await h.create(p);
    let merchant = await h.order.get(p.b.actor, p.out.orderId),
      admin = await h.order.adminGet(SYSTEM_SCOPE, p.out.orderId);
    expect(merchant.afterSales).toMatchObject([
      {
        cancelRequestId: first.cancelRequestId,
        status: "pending_approval",
        lines: [{ returnedPoints: null, convertedPoints: null, forfeitedPoints: null }],
      },
    ]);
    expect(admin.cancelRequests.map((row) => row.cancelRequestId)).toEqual([first.cancelRequestId]);
    await h.requests.withdraw(p.actor, first.cancelRequestId, { note: "保留已关闭真实申请" });
    h.clock.advance(1000);
    const second = await h.create(p),
      approver = await h.staff();
    await h.requests.approve(
      approver,
      second.cancelRequestId,
      await h.approveBody(second.cancelRequestId),
    );
    await h.execute(await h.staff(), {
      id: second.cancelRequestId,
      confirm: { requestNo: second.requestNo, totalRefundPoints: second.totalRefundPoints },
    });
    const saved = await h.saved(second.cancelRequestId),
      before = await snapshotTables(h.prisma, REQUEST_TABLES);
    merchant = await h.order.get(p.b.actor, p.out.orderId);
    admin = await h.order.adminGet(SYSTEM_SCOPE, p.out.orderId);
    expect(merchant.afterSales.map((row) => row.cancelRequestId)).toEqual([
      second.cancelRequestId,
      first.cancelRequestId,
    ]);
    expect(merchant.afterSales[1]).toMatchObject({
      status: "not_executed",
      closeReason: "withdrawn",
    });
    const actual = saved.cancelRequestLines[0]!;
    expect(merchant.afterSales[0]!.lines[0]).toMatchObject({
      refundPoints: actual.refundPoints,
      returnedPoints: actual.returnedPoints,
      convertedPoints: actual.convertedPoints,
      forfeitedPoints: actual.forfeitedPoints,
    });
    expect(admin.cancelRequests).toMatchObject([
      { cancelRequestId: second.cancelRequestId, status: "done" },
      { cancelRequestId: first.cancelRequestId, status: "not_executed" },
    ]);
    await expect(
      h.order.adminGet(ownTaskScope((await h.staff()).staff!.staff), p.out.orderId),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      h.tx.run((tx) =>
        readOrderAfterSales(tx, {
          orderId: p.out.orderId,
          entityId: uuidv7(),
          storeId: p.b.store.id,
        }),
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      h.order.get(
        { ...p.b.actor, membership: { ...p.b.actor.membership, role: "clerk" } },
        p.out.orderId,
      ),
    ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, REQUEST_TABLES));
  });

  it("整店取消空订单头仍按真实明细归本单，本单合计不混入另一单与广告", async () => {
    const h = requestsHarness(await db.prisma());
    closers.push(h.close);
    const w = await h.qualificationOrder(2),
      extra = await drama(h, 150);
    const second = await h.order.create(
      w.actor,
      await body({ ...h, deps: h.orderDeps }, w.b, [extra.id]),
    );
    await h.unassignedAd(w);
    const reviewer = await h.staff();
    await h.param("refund.points.auto_approve_before_production", false, reviewer);
    const impact = await h.profile.admin.rejectQuote(reviewer.staff!, w.submissionId);
    await h.profile.admin.reject(reviewer.ctx, reviewer.staff!, w.submissionId, {
      isFinal: true,
      reasonCodes: ["R01"],
      note: "真实整店取消投影",
      confirm: {
        pendingStartOrderCount: impact.pendingStartOrderCount,
        pendingAssignAdCount: impact.pendingAssignAdCount,
        heldPoints: impact.heldPoints,
      },
    });
    await h.deliver(w.store.id);
    const request = await h.prisma.cancelRequest.findFirstOrThrow({
      where: { storeId: w.store.id, kind: "qualification_cancel" },
      include: { cancelRequestLines: true },
    });
    expect(request.dramaOrderId).toBeNull();
    const before = await snapshotTables(h.prisma, [
      ...MONEY_TABLES,
      "cancel_request",
      "cancel_request_line",
    ]);
    for (const orderId of [w.id, second.orderId]) {
      const itemIds = (
        await h.prisma.orderItem.findMany({
          where: { dramaOrderId: orderId },
          select: { id: true },
        })
      ).map((row) => row.id);
      const view = await h.order.get(w.actor, orderId),
        record = view.afterSales[0]!;
      expect(record.cancelRequestId).toBe(request.id);
      expect(record.lines.map((line) => line.orderItemId).sort()).toEqual(itemIds.sort());
      expect(record.totalRefundPoints).toBe(
        request.cancelRequestLines
          .filter((line) => line.targetType === "order_item" && itemIds.includes(line.targetId))
          .reduce((sum, line) => sum + line.refundPoints, 0),
      );
      expect(record.totalRefundPoints).toBeLessThan(request.totalRefundPoints);
    }
    assertSnapshotsEqual(
      before,
      await snapshotTables(h.prisma, [...MONEY_TABLES, "cancel_request", "cancel_request_line"]),
    );
  });
});
