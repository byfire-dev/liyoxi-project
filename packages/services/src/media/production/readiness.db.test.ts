import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../../testing/index.js";
import { productionReady } from "../../delivery/quality.js";
import { declareManualProduction, ensureProductionStubs } from "../production-stub.js";
import { harness } from "../__fixtures__/production.js";
import type { Harness } from "../__fixtures__/production.js";

const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120_000);
afterAll(async () => {
  await h?.deps.media.jobs.shutdown();
});
async function source() {
  const o = await h.order(true),
    staff = await h.staff();
  const file = await h.make.fileObject({
    category: "sample_video",
    bucket: "secure",
    scopeType: "store",
    entityId: o.entity.id,
    storeId: o.store.id,
    uploadActorType: "staff",
    uploadActorId: staff.row.id,
    uploadClient: "admin",
    ext: "mp4",
    mime: "video/mp4",
    declaredMime: "video/mp4",
  });
  const input = {
    fileId: file.id,
    kind: "sample" as const,
    orderItemId: o.items[0]!.id,
    episodeNo: 1,
    entityId: o.entity.id,
    storeId: o.store.id,
    productionTier: "standard",
    uploadedByStaffId: staff.row.id,
    forcedByDrama: false,
  };
  await h.tx.run((tx) => declareManualProduction(tx, h.clock, input));
  return { file, input };
}
describe("交付制作事实不能由同步桥或孤立ready代替", () => {
  it("ready声明没有真实probe和media_check时不允许QC", async () => {
    const { file } = await source();
    await h.prisma.productionRecord.update({
      where: { fileId: file.id },
      data: { pipelineState: "ready" },
    });
    await expect(
      h.tx.run((tx) => productionReady(tx, file.id, h.deps.media)),
    ).rejects.toMatchObject({ error: "PRODUCTION_NOT_READY" });
    expect(await h.prisma.qcRecord.count()).toBe(0);
  });
  it("登记stored人工文件只排真实probe，不能生成ready原片播放资产", async () => {
    const { file, input } = await source();
    await h.tx.run((tx) => ensureProductionStubs(tx, h.deps, [input]));
    expect(
      (await h.prisma.productionRecord.findUniqueOrThrow({ where: { fileId: file.id } }))
        .pipelineState,
    ).toBe("uploading");
    expect(await h.prisma.playableAsset.count({ where: { sourceFileId: file.id } })).toBe(0);
  });
});
