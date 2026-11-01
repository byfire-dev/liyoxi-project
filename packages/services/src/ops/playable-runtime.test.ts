// Pure access/signing-boundary probes. Production asset provenance is covered by the DB fixture test.
import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import type { MerchantPlayableAsset } from "../media/index.js";
import type { readAdPlayableFacts } from "../ad/index.js";
import type { readSamplePlayableFacts } from "../delivery/index.js";
import type { readTrailerMediaFacts } from "../content/index.js";
import { createMerchantPlayables } from "./playable-runtime.js";
import type { MerchantPlayablesDeps } from "./playable-runtime.js";

const owners = vi.hoisted(() => ({
  asset: vi.fn<(tx: Tx, id: string) => Promise<MerchantPlayableAsset | null>>(),
  ad: vi.fn<typeof readAdPlayableFacts>(),
  sample: vi.fn<typeof readSamplePlayableFacts>(),
  trailer: vi.fn<typeof readTrailerMediaFacts>(),
}));
vi.mock("../media/index.js", () => ({ readMerchantPlayableAsset: owners.asset }));
vi.mock("../ad/index.js", () => ({ readAdPlayableFacts: owners.ad }));
vi.mock("../delivery/index.js", () => ({ readSamplePlayableFacts: owners.sample }));
vi.mock("../content/index.js", () => ({ readTrailerMediaFacts: owners.trailer }));

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-7111-8111-111111111111`;
const now = new Date("2026-01-05T04:00:00Z");
function asset(kind: "ad" | "sample" | "trailer"): MerchantPlayableAsset {
  const entityId = kind === "trailer" ? null : id(5),
    storeId = kind === "trailer" ? null : id(6);
  const sourceFileId = id(2),
    renditionId = kind === "ad" ? sourceFileId : id(3);
  const renditions = [
    {
      quality: kind === "trailer" ? ("sd" as const) : ("source" as const),
      fileId: renditionId,
      width: 1080,
      height: 1920,
      bitrateKbps: null,
    },
  ];
  const source = {
    id: sourceFileId,
    category: kind === "ad" ? "ad_video" : kind === "sample" ? "sample_video" : "trailer_src",
    scopeType: kind === "trailer" ? "platform" : "store",
    entityId,
    storeId,
    status: "stored",
    moderationState: "none",
    bucket: "media",
    objectKey: "source.mp4",
    ext: "mp4",
    etag: "etag",
    sha256: "1".repeat(64),
    sizeBytes: 1234n,
    deletedAt: null,
    erasedAt: null,
    updatedAt: now,
  };
  return {
    asset: {
      id: id(1),
      kind,
      entityId,
      storeId,
      ownerType: kind === "ad" ? "ad" : kind === "sample" ? "order_item" : "drama",
      ownerId: id(4),
      sourceFileId,
      state: "ready",
      durationMs: 60_000,
      width: 1080,
      height: 1920,
      renditions,
      coverFileId: null,
      watermark: null,
      specVersion: 1,
      readyAt: now,
      retiredAt: null,
      updatedAt: now,
      sourceFile: {
        mediaInfo: {
          coverFileId: null,
          durationMs: 60_000,
          displayWidth: 1080,
          displayHeight: 1920,
        },
      },
    },
    renditions,
    posterFileId: null,
    refs: [
      { fileId: sourceFileId, refType: "playable_asset", refId: id(1), role: "source" },
      { fileId: renditionId, refType: "playable_asset", refId: id(1), role: "rendition" },
    ],
    files:
      kind === "ad"
        ? [source]
        : [
            source,
            {
              ...source,
              id: renditionId,
              category: kind === "sample" ? "sample_wm" : "trailer_out",
              bucket: kind === "trailer" ? "pub" : "media",
              objectKey: "preview.mp4",
            },
          ],
  };
}
function setup(value: MerchantPlayableAsset) {
  // Opaque handle only. All owner reads are explicit probes, never simulated database writes.
  const tx = Object.freeze({}) as Tx;
  const runner: TxRunner = { run: async <T>(fn: (value: Tx) => Promise<T>) => fn(tx) };
  const signRead = vi.fn<MerchantPlayablesDeps["media"]["signRead"]>().mockResolvedValue({
    url: "https://media.example.invalid/ephemeral",
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  });
  const member = vi.fn<MerchantPlayablesDeps["tenant"]["resolveMembership"]>().mockResolvedValue({
    memberId: id(7),
    entityId: id(5),
    storeId: id(6),
    role: "owner",
    storeMode: "active",
  });
  const requireEnabled = vi
    .fn<MerchantPlayablesDeps["config"]["flags"]["requireEnabled"]>()
    .mockResolvedValue(undefined);
  const flags: MerchantPlayablesDeps["config"]["flags"] = {
    requireEnabled,
    isEnabled: vi.fn().mockResolvedValue(false),
    evaluate: vi.fn(),
    forClient: vi.fn(),
    value: vi.fn(),
    minClientVersion: vi.fn(),
    selfCheck: vi.fn(),
  };
  owners.asset.mockImplementation(async () => structuredClone(value));
  owners.ad.mockResolvedValue({
    id: id(10),
    adId: id(4),
    fileId: id(2),
    versionNo: 1,
    pushedAt: now,
    previewChannels: ["weapp"],
    updatedAt: now,
  });
  owners.sample.mockResolvedValue({
    id: id(11),
    deliveryTicketId: id(12),
    fileId: id(2),
    versionNo: 1,
    status: "pushed",
    pushedAt: now,
    previewChannels: ["weapp"],
    updatedAt: now,
  });
  owners.trailer.mockResolvedValue({
    dramaId: id(4),
    status: "listed",
    isAiGenerated: false,
    posterFileId: null,
    targetPlayableAssetId: id(1),
    currentPlayableAssetId: id(1),
  });
  const service = createMerchantPlayables({
    tx: runner,
    clock: { now: () => now },
    config: { flags },
    tenant: { resolveMembership: member },
    media: { signRead, adProductionFacts: vi.fn(), deliveryProductionFacts: vi.fn() },
  });
  return { service, signRead, member, requireEnabled };
}
beforeEach(() => {
  for (const mock of Object.values(owners)) mock.mockReset();
});
const owner = { merchantUserId: id(8), storeId: id(6) };

it("缺资产先404；匿名广告和样片都401且零签发", async () => {
  for (const kind of ["ad", "sample"] as const) {
    const h = setup(asset(kind));
    owners.asset.mockResolvedValueOnce(null);
    await expect(h.service.get({}, id(1))).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(h.service.get({}, id(1))).rejects.toMatchObject({ error: "AUTH_REQUIRED" });
    expect(h.signRead).not.toHaveBeenCalled();
  }
});

it("当前门店的店员与跨店老板都不能取得广告签名", async () => {
  const h = setup(asset("ad"));
  h.member.mockResolvedValueOnce({
    memberId: id(7),
    entityId: id(5),
    storeId: id(6),
    role: "clerk",
    storeMode: "active",
  });
  await expect(h.service.get(owner, id(1))).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
  h.member.mockResolvedValueOnce({
    memberId: id(7),
    entityId: id(5),
    storeId: id(20),
    role: "owner",
    storeMode: "active",
  });
  await expect(h.service.get({ ...owner, storeId: id(20) }, id(1))).rejects.toMatchObject({
    error: "NOT_FOUND",
  });
  expect(h.signRead).not.toHaveBeenCalled();
});

it.each(["source", "rendition"])("广告缺少live %s引用时先拒签", async (role) => {
  const value = asset("ad");
  value.refs = value.refs.filter((ref) => ref.role !== role);
  const h = setup(value);
  await expect(h.service.get(owner, id(1))).rejects.toMatchObject({
    error: "PLAYABLE_UNAVAILABLE",
  });
  expect(h.signRead).not.toHaveBeenCalled();
});

it("预告片允许匿名且静音；样片开关关闭在生产证明或签名前拒绝", async () => {
  const trailer = setup(asset("trailer"));
  await expect(trailer.service.get({}, id(1))).resolves.toMatchObject({
    kind: "trailer",
    muted: true,
    autoplay: false,
  });
  expect(trailer.member).not.toHaveBeenCalled();
  expect(trailer.signRead).toHaveBeenCalledTimes(1);
  const sample = setup(asset("sample"));
  sample.requireEnabled.mockRejectedValueOnce(new AppError("FEATURE_DISABLED"));
  await expect(sample.service.get(owner, id(1))).rejects.toMatchObject({
    error: "FEATURE_DISABLED",
  });
  expect(sample.signRead).not.toHaveBeenCalled();
});

it("签名等待间预告片current资格变化后不返回旧地址", async () => {
  const h = setup(asset("trailer"));
  h.signRead.mockImplementationOnce(async () => {
    owners.trailer.mockResolvedValue({
      dramaId: id(4),
      status: "listed",
      isAiGenerated: false,
      posterFileId: null,
      targetPlayableAssetId: id(30),
      currentPlayableAssetId: id(30),
    });
    return {
      url: "https://media.example.invalid/withheld",
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
  });
  await expect(h.service.get({}, id(1))).rejects.toMatchObject({ error: "NOT_FOUND" });
  expect(h.signRead).toHaveBeenCalledTimes(1);
});
