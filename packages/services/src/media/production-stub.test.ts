import { beforeAll, afterAll, it, expect } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/production.js";
import type { Harness } from "./__fixtures__/production.js";
import { declareManualProduction, ensureProductionStubs } from "./production-stub.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
it("同步桥只处理本上下文人工无AI；错上下文、拒收、AI pending、真实派生保持原结论", async () => {
  const o = await h.order(true),
    staff = await h.staff(),
    item = o.items[0]!;
  const input = async () => {
    const f = await h.make.fileObject({
      category: "sample_video",
      scopeType: "store",
      entityId: o.entity.id,
      storeId: o.store.id,
    });
    return {
      fileId: f.id,
      kind: "sample" as const,
      entityId: o.entity.id,
      storeId: o.store.id,
      orderItemId: item.id,
      episodeNo: 1,
      productionTier: item.productionModel,
      uploadedByStaffId: staff.row.id,
    };
  };
  const good = await input();
  await h.tx.run((tx) => declareManualProduction(tx, h.clock, good));
  expect((await h.tx.run((tx) => ensureProductionStubs(tx, h.deps, [good])))[0]).toMatchObject({
    record: { pipelineState: "ready", aigcState: "not_required" },
    playable: { state: "ready", durationMs: null, width: null, height: null },
  });
  for (const state of ["rejected", "ai_pending", "normalized"]) {
    const i = await input();
    await h.tx.run((tx) =>
      declareManualProduction(tx, h.clock, {
        ...i,
        ...(state === "ai_pending" ? { aiUsage: { used: true, tools: [] } } : {}),
      }),
    );
    if (state !== "ai_pending")
      await h.prisma.productionRecord.update({
        where: { fileId: i.fileId },
        data:
          state === "rejected"
            ? { pipelineState: "rejected" }
            : { pipelineState: "checking", source: "normalized" },
      });
    if (state === "rejected")
      await expect(h.tx.run((tx) => ensureProductionStubs(tx, h.deps, [i]))).rejects.toMatchObject({
        error: "PRODUCTION_NOT_READY",
      });
    else await h.tx.run((tx) => ensureProductionStubs(tx, h.deps, [i]));
    const row = await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: i.fileId } });
    expect(row.pipelineState).toBe(
      state === "ai_pending" ? "uploading" : state === "rejected" ? "rejected" : "checking",
    );
    expect(await h.prisma.playableAsset.count({ where: { sourceFileId: i.fileId } })).toBe(0);
  }
  const other = await h.make.orderItem({ dramaOrderId: o.order.id, phase: "producing" }),
    wrong = await input();
  await h.tx.run((tx) => declareManualProduction(tx, h.clock, { ...wrong, orderItemId: other.id }));
  await expect(h.tx.run((tx) => ensureProductionStubs(tx, h.deps, [wrong]))).rejects.toMatchObject({
    error: "FILE_NOT_USABLE",
    details: { reason: "context_mismatch" },
  });
  expect(
    (await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: wrong.fileId } }))
      .orderItemId,
  ).toBe(other.id);
}, 60000);
