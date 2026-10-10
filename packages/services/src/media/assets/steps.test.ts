import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { assetDisplayStatus, assetSelectable, nextAssetSteps } from "./steps.js";
import type { AssetStepInput, AssetStepJob } from "./steps.js";

const asset: AssetStepInput = {
  type: "image",
  processingState: "processing",
  moderationState: "pending",
  deleted: false,
  merchantImages: true,
  promptVersion: 1,
};
const job = (kind: string, state = "succeeded", fileId: string | null = "file"): AssetStepJob => ({
  kind,
  state,
  fileId,
  promptVersion: 1,
});

describe("素材理解纯决策", () => {
  it("商家图片先审核，审核结束后才识图，全部文件结束后才汇总", () => {
    expect(nextAssetSteps(asset, [{ id: "file" }], [], []).create).toEqual([
      { kind: "audit_image_wx", fileId: "file", insightKind: null },
    ]);
    expect(
      nextAssetSteps(asset, [{ id: "file" }], [], [job("audit_image_wx")]).create[0]?.kind,
    ).toBe("vision");
    expect(
      nextAssetSteps(asset, [{ id: "file" }], [], [job("audit_image_wx"), job("vision")]).create[0]
        ?.kind,
    ).toBe("digest");
  });
  it("失败与跳过可以收敛，仍如实保留partial，不伪造成功洞察", () => {
    const result = nextAssetSteps(
      asset,
      [{ id: "file" }],
      [
        { fileId: "file", kind: "vision", promptVersion: 1, status: "skipped" },
        { fileId: null, kind: "digest", promptVersion: 1, status: "failed" },
      ],
      [job("audit_image_wx", "failed")],
    );
    expect(result).toEqual({ create: [], settled: true, partial: true });
  });
  it("block、删除停止派任务；旧prompt与运行中任务不会被当成新结果", () => {
    expect(
      nextAssetSteps({ ...asset, moderationState: "block" }, [{ id: "file" }], [], []).create,
    ).toEqual([]);
    expect(nextAssetSteps({ ...asset, deleted: true }, [{ id: "file" }], [], []).create).toEqual(
      [],
    );
    expect(
      nextAssetSteps(asset, [{ id: "file" }], [], [job("audit_image_wx", "running")]),
    ).toMatchObject({ create: [], settled: false });
    expect(
      nextAssetSteps({ ...asset, promptVersion: 2 }, [{ id: "file" }], [], [job("audit_image_wx")])
        .create[0]?.kind,
    ).toBe("audit_image_wx");
  });
  it("任意已结束步骤排列与重复调用都不改变后继计划", () => {
    const rows = [job("audit_image_wx"), job("vision"), job("digest", "succeeded", null)];
    fc.assert(
      fc.property(fc.shuffledSubarray(rows, { minLength: 3, maxLength: 3 }), (order) => {
        const result = nextAssetSteps(asset, [{ id: "file" }], [], order);
        expect(result).toEqual({ create: [], settled: true, partial: false });
        expect(nextAssetSteps(asset, [{ id: "file" }], [], order)).toEqual(result);
      }),
      { numRuns: 100 },
    );
  });
  it("未处理或未复核总显示整理中；肖像待补可以参考但补拍不可参考", () => {
    expect(assetDisplayStatus("processing", "reviewed", "ready", 1)).toBe("organizing");
    expect(assetDisplayStatus("processed", "unreviewed", null, 1)).toBe("organizing");
    expect(assetDisplayStatus("processed", "reviewed", "ready", 1)).toBe("adopted");
    expect(
      assetSelectable({
        deletedAt: null,
        moderationState: "pending",
        usability: "need_portrait_auth",
      }),
    ).toBe(true);
    expect(
      assetSelectable({ deletedAt: null, moderationState: "pass", usability: "need_reshoot" }),
    ).toBe(false);
  });
});
