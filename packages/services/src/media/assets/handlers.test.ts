import { expect, it, vi } from "vitest";
import type { MediaJob } from "@liyoxi/db";
import { uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { MediaJobHandler } from "../jobs/types.js";
import { combineAssetHandler } from "./handlers.js";
import { AssetJobInputSchema, assetJobOwned } from "./pipeline.js";

function fixture(parentType: string | null, input: MediaJob["input"]): MediaJob {
  const now = new Date("2026-10-10T00:00:00Z"),
    parsed = AssetJobInputSchema.safeParse(input);
  const assetId = parsed.success ? parsed.data.assetId : uuidv7();
  return {
    id: uuidv7(),
    kind: "audit_text",
    provider: "fake",
    mode: "local",
    subjectType: "store_asset",
    subjectId: assetId,
    parentType,
    parentId: parentType ? assetId : null,
    input,
    dedupeKey: parsed.success
      ? `asset:${assetId}:${parsed.data.runId}:audit_text:text:v1`
      : "old-file-input",
    state: "queued",
    attemptNo: 0,
    maxAttempts: 3,
    leaseOwner: null,
    externalJobId: null,
    output: null,
    errorCode: null,
    errorMessage: null,
    isRetryable: false,
    nextRunAt: now,
    deadlineAt: new Date(now.getTime() + 60_000),
    startedAt: null,
    finishedAt: null,
    billableQty: null,
    billableUnit: null,
    estCostMicro: null,
    createdAt: now,
    updatedAt: now,
  };
}
const assetInput = () => ({
  assetMarker: "store_asset_v1" as const,
  assetId: uuidv7(),
  fileId: null,
  promptVersion: 1,
  runId: uuidv7(),
  selected: [],
  etag: null,
  crc64: null,
  sizeBytes: null,
  coverFileId: uuidv7(),
});
function pair() {
  const original: MediaJobHandler = {
    kind: "audit_text",
    mode: "local",
    provider: "fake",
    claims: (job) =>
      job.parentType === null &&
      typeof job.input === "object" &&
      job.input !== null &&
      "fileText" in job.input,
    validInput: (value) => typeof value === "object" && value !== null && "fileText" in value,
    validOutput: (value) => value === "file-result",
    current: vi.fn(async () => true),
    execute: vi.fn(async () => ({ state: "succeeded" as const, output: "file-result" })),
  };
  const asset: MediaJobHandler = {
    kind: "audit_text",
    mode: "local",
    provider: "fake",
    claims: assetJobOwned,
    validInput: (input) => AssetJobInputSchema.safeParse(input).success,
    validOutput: (value) => value === "asset-result",
    current: vi.fn(async () => true),
    execute: vi.fn(async () => ({ state: "succeeded" as const, output: "asset-result" })),
  };
  return { original, asset, combined: combineAssetHandler(original, asset) };
}

it("相同 kind 的旧文件与素材严格按真实 parent 归属，执行仅进入所属 handler", async () => {
  const { original, asset, combined } = pair(),
    signal = new AbortController().signal;
  const old = fixture(null, { fileText: "原文件文字" }),
    owned = fixture("store_asset", assetInput());
  expect(combined.claims!(old)).toBe(true);
  expect(combined.claims!(owned)).toBe(true);
  expect(await combined.execute(old, undefined, signal)).toEqual({
    state: "succeeded",
    output: "file-result",
  });
  expect(await combined.execute(owned, undefined, signal)).toEqual({
    state: "succeeded",
    output: "asset-result",
  });
  expect(original.execute).toHaveBeenCalledOnce();
  expect(asset.execute).toHaveBeenCalledOnce();
});

it("素材 parent 的坏 marker/旧文件输入/错 subject/dedupe 都拒领，不回落原文件 handler", async () => {
  const { original, combined } = pair();
  const valid = assetInput(),
    owned = fixture("store_asset", valid);
  const cases = [
    fixture("store_asset", { ...valid, assetMarker: "wrong" }),
    fixture("store_asset", { fileText: "旧格式" }),
    { ...owned, subjectId: uuidv7() },
    { ...owned, dedupeKey: "borrow-old-schema" },
    fixture(null, valid),
    fixture("playable_asset", valid),
    fixture("store_asset", { unknown: true }),
  ];
  for (const job of cases) {
    expect(combined.claims!(job)).toBe(false);
    if (!combined.validInput(job.input)) expect(await combined.current({} as Tx, job)).toBe(false);
  }
  expect(original.current).not.toHaveBeenCalled();
  expect(original.execute).not.toHaveBeenCalled();
});
