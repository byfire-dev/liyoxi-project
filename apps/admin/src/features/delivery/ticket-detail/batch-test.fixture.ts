import type {
  BatchUploadCredentials,
  UploadBatchDetail,
  UploadBatchItemView,
} from "@liyoxi/contract";
export const batchId = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
export const batchNow = Date.parse("2026-10-09T03:00:00Z");
export function batchItem(n = 1): UploadBatchItemView {
  return {
    uploadBatchItemId: batchId(n + 100),
    fileId: batchId(n + 200),
    originalName: `第${n}集.mp4`,
    sizeBytes: "1",
    uploadKey: `incoming/b${batchId(1)}/${batchId(n + 200)}.mp4`,
    fileStatus: "pending",
    rejectReason: null,
    episodeNo: n,
    episodeTitle: `第${n}集`,
    matchMethod: "pattern",
    state: "pending",
    durationMs: null,
    previousDurationMs: null,
    isDurationDiffWarn: false,
    check: null,
    aiUsage: null,
    updatedAt: new Date(batchNow).toISOString(),
  };
}
export function batchFixture(patch: Partial<UploadBatchDetail> = {}): UploadBatchDetail {
  return {
    uploadBatchId: batchId(1),
    purpose: "final_release",
    targetId: batchId(2),
    targetLabel: "虚构20集工单",
    variant: "common",
    scope: "full",
    state: "matching",
    expectedCount: 20,
    replaceReason: null,
    isContentChanged: false,
    note: null,
    aiUsage: {
      used: false,
      tools: [],
      declaredBy: batchId(3),
      declaredAt: new Date(batchNow).toISOString(),
      forcedByDrama: false,
    },
    bucket: "test-media-1250000000",
    region: "ap-beijing",
    prefix: `incoming/b${batchId(1)}/`,
    expiresAt: new Date(batchNow + 72 * 3600_000).toISOString(),
    committedAt: null,
    createdBy: {
      staffId: batchId(3),
      staffNo: 1001,
      name: "虚构剪辑",
      roleKey: "editor",
      isLead: false,
      status: "active",
    },
    createdAt: new Date(batchNow).toISOString(),
    updatedAt: new Date(batchNow).toISOString(),
    counts: { total: 1, pending: 1, uploaded: 0, checked: 0, rejected: 0, skipped: 0, replaced: 0 },
    coverage: {
      missingEpisodeNos: Array.from({ length: 19 }, (_, index) => index + 2),
      duplicateEpisodeNos: [],
      unmatchedItemIds: [],
      needsSequenceConfirm: false,
    },
    items: [batchItem()],
    actions: ["start", "refresh-credentials", "cancel"],
    ...patch,
  };
}
export function batchCredentials(): BatchUploadCredentials {
  const batch = batchFixture();
  return {
    bucket: batch.bucket,
    region: batch.region,
    prefix: batch.prefix,
    sts: {
      tmpSecretId: "fictional-public",
      tmpSecretKey: "fictional-key",
      sessionToken: "fictional-token",
      startTime: new Date(batchNow).toISOString(),
      expiredTime: new Date(batchNow + 1800_000).toISOString(),
    },
    chunkSize: 8 * 1024 * 1024,
    fileParallel: 3,
    chunkParallel: 4,
    expiresAt: new Date(batchNow + 1800_000).toISOString(),
  };
}
