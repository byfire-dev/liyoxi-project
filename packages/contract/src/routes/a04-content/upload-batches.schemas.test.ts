import { describe, expect, it } from "vitest";
import {
  UploadBatchCreateBodySchema,
  UploadBatchItemUpdateBodySchema,
  UploadBatchEmptyBodySchema,
} from "./upload-batches.schemas.js";

const targetId = "019b08b0-9000-7000-8000-000000000001";
const master = {
  purpose: "drama_master",
  targetId,
  scope: "full",
  files: [{ clientToken: "test_1", originalName: "E01.mp4", sizeBytes: "32" }],
};
describe("batch input ownership and purpose boundaries", () => {
  it("requires a final declaration but rejects client-supplied server provenance", () => {
    const final = { ...master, purpose: "final_release" };
    expect(UploadBatchCreateBodySchema.safeParse(final).success).toBe(false);
    expect(
      UploadBatchCreateBodySchema.parse({ ...final, aiUsage: { used: false, tools: [] } })
        .isContentChanged,
    ).toBe(false);
    for (const injected of [
      { declaredBy: targetId },
      { declaredAt: "2026-10-09T00:00:00.000Z" },
      { forcedByDrama: false },
    ])
      expect(
        UploadBatchCreateBodySchema.safeParse({
          ...final,
          aiUsage: { used: false, tools: [], ...injected },
        }).success,
      ).toBe(false);
  });
  it("does not accept master replacement facts for final outputs or AI declarations for masters", () => {
    expect(UploadBatchCreateBodySchema.parse(master).aiUsage).toBeUndefined();
    expect(
      UploadBatchCreateBodySchema.safeParse({ ...master, aiUsage: { used: true, tools: [] } })
        .success,
    ).toBe(false);
    const final = { ...master, purpose: "final_release", aiUsage: { used: false, tools: [] } };
    expect(
      UploadBatchCreateBodySchema.safeParse({ ...final, replaceReason: "quality_fix" }).success,
    ).toBe(false);
    expect(
      UploadBatchCreateBodySchema.safeParse({ ...final, isContentChanged: true }).success,
    ).toBe(false);
  });
  it("strictly requires exactly one update and accepts clearing an episode mapping", () => {
    for (const bad of [
      {},
      { skip: false },
      { skip: true, episodeNo: 1 },
      { episodeNo: 1, replacementFile: master.files[0] },
      { episodeNo: 0 },
      { episodeNo: 1, aiUsage: {} },
    ])
      expect(UploadBatchItemUpdateBodySchema.safeParse(bad).success).toBe(false);
    expect(UploadBatchItemUpdateBodySchema.parse({ episodeNo: null })).toEqual({ episodeNo: null });
    expect(UploadBatchItemUpdateBodySchema.parse({ skip: true })).toEqual({ skip: true });
    expect(UploadBatchItemUpdateBodySchema.parse({ replacementFile: master.files[0] })).toEqual({
      replacementFile: master.files[0],
    });
  });
  it("keeps complete and credential operations from accepting caller state or objects", () => {
    expect(UploadBatchEmptyBodySchema.parse({})).toEqual({});
    for (const field of ["status", "uploadKey", "bucket", "fileId", "etag", "checked"])
      expect(UploadBatchEmptyBodySchema.safeParse({ [field]: "forged" }).success).toBe(false);
  });
  it("rejects zero/negative/exponent sizes and non-token paths without inventing a file count", () => {
    for (const sizeBytes of ["0", "-1", "1e8", "1.5", " 32"])
      expect(
        UploadBatchCreateBodySchema.safeParse({
          ...master,
          files: [{ ...master.files[0], sizeBytes }],
        }).success,
      ).toBe(false);
    expect(
      UploadBatchCreateBodySchema.safeParse({
        ...master,
        files: [{ ...master.files[0], clientToken: "../escape" }],
      }).success,
    ).toBe(false);
    expect(UploadBatchCreateBodySchema.safeParse({ ...master, expectedCount: 1 }).success).toBe(
      false,
    );
  });
});
