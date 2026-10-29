import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MaterialDownloadBody } from "@liyoxi/contract";
import { readMaterialAdVersions } from "../ad/index.js";
import { createApproval } from "../approval/index.js";
import { createFlow } from "../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createIdempotencyContext,
  uuidv7,
} from "../kernel/index.js";
import { readMaterialMasters } from "../content/index.js";
import { createStoreAssetCopyOwner, linkAssetReferences } from "../media/index.js";
import { createProfile, readMaterialProfile } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import {
  createBatchMediaForTest,
  createDeliveryProductionTools,
  createMediaAssetsHarness,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "../testing/index.js";
import type { Media, MediaProductionDeps } from "../media/index.js";
import type { ProfileViewer } from "../profile/index.js";
import { createDownloadRecords } from "./download-records.js";
import { createProductionMaterials, selectMaterialAdVersions } from "./materials.js";

const db = useSeededDatabase("services", { label: "materials" });
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let batchMedia: Media;
let tools: ReturnType<typeof createDeliveryProductionTools>;
beforeAll(async () => {
  h = await createMediaAssetsHarness(await db.prisma());
  tools = createDeliveryProductionTools(h.fake);
  const production: MediaProductionDeps = {
    tool: tools.tool,
    workspace: tools.workspace,
    cloud: h.fake.media,
    config: {
      aigc: {
        Label: "1",
        ContentProducer: "TEST-MATERIALS",
        ReservedCode1: "",
        ContentPropagator: "",
        ReservedCode2: "",
      },
      templates: {
        normalize: "normalize",
        sample: "sample",
        sd: "sd",
        hd: "hd",
        brand: "brand",
        ai: "ai",
      },
    },
    parameters: async () => ({
      finalMaxMb: 200,
      softDurationMs: 180_000,
      ruleVersion: 1,
      specVersion: 1,
    }),
    readStoreFacts: async () => null,
  };
  batchMedia = createBatchMediaForTest({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    events: h.events,
    storage: h.fake.storage,
    production,
  });
});
afterAll(async () => {
  await batchMedia?.jobs.shutdown();
  await tools?.tools.close();
  await h?.close();
});
const materials = () =>
  createProductionMaterials({
    tx: h.tx,
    clock: h.clock,
    media: h.media,
    readMasters: readMaterialMasters,
    readProfile: readMaterialProfile,
    readAdVersions: readMaterialAdVersions,
  });
async function parent(scope = { entityId: h.merchant.entity.id, storeId: h.merchant.store.id }) {
  const drama = await h.make.drama({ totalEpisodes: 3 });
  for (let episodeNo = 1; episodeNo <= 3; episodeNo++)
    await h.make.dramaEpisode({ dramaId: drama.id, episodeNo });
  const order = await h.make.dramaOrder({
    entityId: scope.entityId,
    storeId: scope.storeId,
    status: "producing",
  });
  const item = await h.make.orderItem({
    dramaOrderId: order.id,
    dramaId: drama.id,
    phase: "producing",
    dramaSnapshot: { dramaId: drama.id, title: drama.title },
    episodeCount: 3,
  });
  const ticket = await h.make.deliveryTicket({ orderItemId: item.id, editorId: h.staff.id });
  return { drama, order, item, ticket };
}
async function committedMaster(dramaId: string) {
  // Only codec and storage IO are doubled. Upload, probe, checks and master activation are public services.
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const body = {
    purpose: "drama_master",
    targetId: dramaId,
    scope: "partial",
    replaceReason: "quality_fix",
    isContentChanged: false,
    files: [{ clientToken: uuidv7(), originalName: "第1集.mp4", sizeBytes: String(bytes.length) }],
  };
  const batch = await batchMedia.uploadBatches.create(h.admin, body, {
    idem: createIdempotencyContext({
      mode: "required",
      scope: "admin.uploadBatch.create",
      actor: h.admin.identity.actor,
      key: uuidv7(),
      request: { method: "POST", body },
    }),
  });
  await batchMedia.uploadBatches.start(h.admin, batch.uploadBatchId, {});
  const file = await h.prisma.fileObject.findUniqueOrThrow({
    where: { id: batch.items[0]!.fileId },
  });
  h.fake.storage.put({ bucket: "media", key: file.incomingKey! }, bytes, "video/mp4");
  await batchMedia.uploadBatches.complete(h.admin, batch.items[0]!.uploadBatchItemId, {});
  const promote = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.id}` },
  });
  await batchMedia.promote({ jobId: promote.id });
  const probe = await h.prisma.mediaJob.findFirstOrThrow({
    where: { kind: "probe", subjectId: file.id },
  });
  await batchMedia.jobs.run({ jobId: probe.id });
  expect((await batchMedia.uploadBatches.get(h.admin, batch.uploadBatchId)).state).toBe("ready");
  const result = await batchMedia.uploadBatches.commit(h.admin, batch.uploadBatchId, {});
  return { master: result.masters[0]!, fileId: file.id };
}
async function storedProfileImage() {
  const actor = h.owner;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const registered = await h.media.register(actor, {
    category: "profile_image",
    files: [{ clientToken: uuidv7(), fileName: "门头.png", sizeBytes: String(bytes.length) }],
  });
  const fileId = registered.items[0]!.fileId;
  h.fake.storage.put({ bucket: "asset", key: registered.items[0]!.key }, bytes, "image/png");
  await h.media.complete(actor, fileId);
  const job = await h.prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${fileId}` },
  });
  await h.media.promote({ jobId: job.id });
  return fileId;
}
async function profileReference(orderId: string) {
  const actor = h.owner,
    fileId = await storedProfileImage();
  const flow = createFlow({ assembly: h.assembly, clock: h.clock, events: h.events });
  const tenant = createTenant({ tx: h.tx, clock: h.clock, flow, assembly: h.assembly });
  const approval = createApproval({
    assembly: h.assembly,
    clock: h.clock,
    flow,
    events: h.events,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const profile = createProfile({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    tenant,
    approval,
    events: h.events,
    media: h.media,
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    currentOpenid: async () => "material_fixture_openid",
  });
  const viewer: ProfileViewer = {
    ctx: actor.identity,
    principal: {
      sessionId: h.merchant.user.id,
      merchantUserId: h.merchant.user.id,
      wechatIdentityId: h.merchant.user.id,
      consentStamp: null,
    },
    membership: {
      memberId: h.merchant.owner.id,
      entityId: h.merchant.entity.id,
      storeId: h.merchant.store.id,
      role: "owner",
      storeMode: "active",
    },
  };
  const before = await h.prisma.storeProfile.findUnique({
    where: { storeId: h.merchant.store.id },
  });
  await profile.updateMedia(viewer, {
    draft: true,
    lockVersion: before?.lockVersion ?? 0,
    groups: { door: [{ fileId }] },
  });
  // Historical profile association only: the order has no profile-media input.
  // The file above and profile insert/removal are real services.
  await h.prisma.fileRef.create({
    data: {
      id: uuidv7(),
      fileId,
      refType: "drama_order",
      refId: orderId,
      role: "reference",
      state: "live",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const current = await h.prisma.storeProfile.findUniqueOrThrow({
    where: { storeId: h.merchant.store.id },
  });
  await profile.updateMedia(viewer, {
    draft: true,
    lockVersion: current.lockVersion,
    groups: { door: [{ fileId: await storedProfileImage() }] },
  });
  return fileId;
}
const readTables = [
  "master_checkout",
  "audit_log",
  "idempotency_record",
  "delivery_download_log",
  "download_grant",
];

describe("制作素材的当前事实、签名与取料留痕", { timeout: 60_000 }, () => {
  it("GET只读真实已提交原片、实际订单素材与已移除但订单保留的档案媒体", async () => {
    const p = await parent(),
      master = await committedMaster(p.drama.id);
    const file = await h.stored(),
      file2 = await h.stored(),
      asset = await h.media.assets.create(h.owner, { type: "image", fileIds: [file.id, file2.id] });
    await h.tx.run((tx) =>
      linkAssetReferences(
        tx,
        {
          entityId: p.order.entityId,
          storeId: p.order.storeId,
          ids: [asset.storeAssetId],
          orderId: p.order.id,
          now: h.clock.now(),
        },
        h.media.link,
      ),
    );
    const profileId = await profileReference(p.order.id);
    const otherOrder = await parent(),
      foreignOwner = await h.make.merchant({ verified: true });
    const foreignOrder = await parent({
      entityId: foreignOwner.entity.id,
      storeId: foreignOwner.store.id,
    });
    const before = await snapshotTables(h.prisma, readTables);
    const result = await materials().list(h.admin.identity, h.admin.staff!, p.ticket.id);
    expect(result.masters).toEqual([
      expect.objectContaining({
        dramaEpisodeMasterId: master.master.dramaEpisodeMasterId,
        episodeNo: 1,
        myLastCheckout: null,
      }),
    ]);
    expect(result.storeAssets).toEqual([
      expect.objectContaining({ storeAssetId: asset.storeAssetId }),
    ]);
    expect(result.profileMedia).toEqual([
      expect.objectContaining({ fileId: profileId, source: "profile_media", thumbnail: null }),
    ]);
    expect(result.ads).toEqual([]);
    const history = await createDownloadRecords(h).list(h.admin.staff!, p.item.id, {
      page: 1,
      pageSize: 20,
    });
    expect(history).toEqual({
      releases: [],
      grants: [],
      logs: { items: [], page: 1, pageSize: 20, total: 0 },
    });
    expect(await snapshotTables(h.prisma, readTables)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("fake-storage");
    expect(JSON.stringify(result)).not.toContain("raw");
    for (const ticketId of [otherOrder.ticket.id, foreignOrder.ticket.id])
      await expect(
        materials().downloadUrls(h.admin.identity, h.admin.staff!, ticketId, {
          kind: "profile_media",
          fileId: profileId,
        }),
      ).rejects.toMatchObject({ error: "MATERIAL_NOT_AVAILABLE" });
    const fromAsset = await materials().downloadUrls(
      h.admin.identity,
      h.admin.staff!,
      p.ticket.id,
      { kind: "store_asset", storeAssetId: asset.storeAssetId },
    );
    const fromProfile = await materials().downloadUrls(
      h.admin.identity,
      h.admin.staff!,
      p.ticket.id,
      { kind: "profile_media", fileId: profileId },
    );
    expect(fromAsset.items).toHaveLength(2);
    for (const item of [...fromAsset.items, ...fromProfile.items]) {
      expect(new Date(item.expiresAt).getTime() - h.clock.now().getTime()).toBe(1_800_000);
      expect(h.fake.storage.fetch(item.url).status).toBe(200);
      expect(
        await h.prisma.auditLog.count({ where: { stream: "access", targetId: item.fileId } }),
      ).toBe(1);
    }
  });

  it("真实当前原片逐次签发与更新版本写checkout，30分钟地址不落幂等缓存", async () => {
    const p = await parent(),
      original = await committedMaster(p.drama.id),
      service = materials();
    const beforeKeys = await h.prisma.idempotencyRecord.count();
    for (let count = 1; count <= 2; count++) {
      const result = await service.downloadUrls(h.admin.identity, h.admin.staff!, p.ticket.id, {
        kind: "master",
        episodeNos: [1],
      });
      expect(result.items[0]).toMatchObject({
        kind: "master",
        episodeNo: 1,
        fileId: original.fileId,
        fileName: `${p.drama.title}_第01集_原片.mp4`,
      });
      expect(new Date(result.items[0]!.expiresAt).getTime() - h.clock.now().getTime()).toBe(
        1_800_000,
      );
      expect(h.fake.storage.fetch(result.items[0]!.url)).toMatchObject({
        status: 200,
        contentDisposition: expect.stringContaining(
          encodeURIComponent(`${p.drama.title}_第01集_原片.mp4`),
        ),
      });
      expect(
        await h.prisma.masterCheckout.findUniqueOrThrow({
          where: {
            orderItemId_episodeNo_staffId: {
              orderItemId: p.item.id,
              episodeNo: 1,
              staffId: h.staff.id,
            },
          },
        }),
      ).toMatchObject({
        dramaEpisodeMasterId: original.master.dramaEpisodeMasterId,
        checkoutCount: count,
      });
    }
    const replacement = await committedMaster(p.drama.id);
    const afterReplacementKeys = await h.prisma.idempotencyRecord.count();
    expect(afterReplacementKeys).toBe(beforeKeys + 1);
    expect(
      (await service.list(h.admin.identity, h.admin.staff!, p.ticket.id)).masters[0],
    ).toMatchObject({
      dramaEpisodeMasterId: replacement.master.dramaEpisodeMasterId,
      myLastCheckout: {
        dramaEpisodeMasterId: original.master.dramaEpisodeMasterId,
        checkoutCount: 2,
      },
    });
    await service.downloadUrls(h.admin.identity, h.admin.staff!, p.ticket.id, {
      kind: "master",
      episodeNos: [1],
    });
    expect(
      await h.prisma.masterCheckout.findUniqueOrThrow({
        where: {
          orderItemId_episodeNo_staffId: {
            orderItemId: p.item.id,
            episodeNo: 1,
            staffId: h.staff.id,
          },
        },
      }),
    ).toMatchObject({
      dramaEpisodeMasterId: replacement.master.dramaEpisodeMasterId,
      checkoutCount: 3,
    });
    expect(
      await h.prisma.auditLog.count({ where: { stream: "access", targetId: original.fileId } }),
    ).toBe(2);
    expect(
      await h.prisma.auditLog.count({ where: { stream: "access", targetId: replacement.fileId } }),
    ).toBe(1);
    expect(await h.prisma.idempotencyRecord.count()).toBe(afterReplacementKeys);
  });

  it("真实品牌素材复制A→B→C保留原文件，仅本单目标素材关联可取料", async () => {
    const file = await h.stored();
    const original = await h.media.assets.create(h.owner, {
      type: "image",
      fileIds: [file.id],
      contentTagCodes: ["brand_story"],
    });
    const middle = await h.make.store({ entityId: h.merchant.entity.id });
    const target = await h.make.store({ entityId: h.merchant.entity.id });
    const copy = async (sourceStoreId: string, targetStoreId: string) => {
      const owner = createStoreAssetCopyOwner({
        clock: h.clock,
        media: h.media,
        sla: h.assets.sla,
        timers: h.timers,
        readStore: h.assets.readStore,
      });
      await h.tx.run(async (tx) =>
        owner.apply(
          tx,
          await owner.prepare(tx, {
            entityId: h.merchant.entity.id,
            sourceStoreId,
            targetStoreId,
          }),
        ),
      );
    };
    await copy(h.merchant.store.id, middle.id);
    await copy(middle.id, target.id);
    const copied = await h.prisma.storeAsset.findFirstOrThrow({
      where: { storeId: target.id, sourceStoreAssetId: { not: null } },
    });
    const p = await parent({ entityId: h.merchant.entity.id, storeId: target.id });
    await h.tx.run((tx) =>
      linkAssetReferences(
        tx,
        {
          entityId: p.order.entityId,
          storeId: p.order.storeId,
          ids: [copied.id],
          orderId: p.order.id,
          now: h.clock.now(),
        },
        h.media.link,
      ),
    );
    expect((await h.prisma.fileObject.findUniqueOrThrow({ where: { id: file.id } })).storeId).toBe(
      h.merchant.store.id,
    );
    const service = materials();
    expect((await service.list(h.admin.identity, h.admin.staff!, p.ticket.id)).storeAssets).toEqual(
      [expect.objectContaining({ storeAssetId: copied.id })],
    );
    const result = await service.downloadUrls(h.admin.identity, h.admin.staff!, p.ticket.id, {
      kind: "store_asset",
      storeAssetId: copied.id,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.fileId).toBe(file.id);
    expect(h.fake.storage.fetch(result.items[0]!.url).status).toBe(200);
    const unassociated = await parent({ entityId: h.merchant.entity.id, storeId: middle.id });
    for (const [ticketId, storeAssetId] of [
      [p.ticket.id, original.storeAssetId],
      [unassociated.ticket.id, copied.id],
    ] as const)
      await expect(
        service.downloadUrls(h.admin.identity, h.admin.staff!, ticketId, {
          kind: "store_asset",
          storeAssetId,
        }),
      ).rejects.toMatchObject({ error: "MATERIAL_NOT_AVAILABLE" });
    expect(await h.prisma.auditLog.count({ where: { stream: "access", targetId: file.id } })).toBe(
      1,
    );
  });

  it("越界/缺失原片、非本单广告或素材、非本人任务不泄露URL也不留取料", async () => {
    const p = await parent(),
      service = materials(),
      before = await snapshotTables(h.prisma, readTables);
    const cases: MaterialDownloadBody[] = [
      { kind: "master", episodeNos: [4] },
      { kind: "master", episodeNos: [1] },
      { kind: "ad_version", adVersionId: uuidv7() },
      { kind: "store_asset", storeAssetId: uuidv7() },
      { kind: "profile_media", fileId: uuidv7() },
    ];
    for (const body of cases) {
      await expect(
        service.downloadUrls(h.admin.identity, h.admin.staff!, p.ticket.id, body),
      ).rejects.toBeTruthy();
    }
    const row = await h.make.staff({ staffRoleKey: "editor" });
    const staff = await sampleStaffContext(h.prisma, row.id);
    const ctx = createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } });
    await expect(service.list(ctx, staff, p.ticket.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await expect(
      createDownloadRecords(h).list(staff, p.item.id, { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await snapshotTables(h.prisma, readTables)).toEqual(before);
  });

  it("广告归属投影正向核钉住和浮动版本，排除未确认、外店和失效事实", () => {
    // Ad submission/confirmation belongs to the later ad package. These typed historical
    // facts prove selection only; no terminal ad state or media readiness is fabricated in DB.
    const entityId = uuidv7(),
      storeId = uuidv7(),
      adId = uuidv7();
    const ad = {
      id: adId,
      entityId,
      storeId,
      adNo: "GG20261030001",
      confirmedVersionNo: 2,
      status: "confirmed",
      copy: "门店宣传",
    };
    type AdFacts = Parameters<typeof selectMaterialAdVersions>[0];
    const versions: AdFacts["versions"] = [1, 2].map((versionNo) => ({
      id: uuidv7(),
      adId,
      entityId,
      storeId,
      versionNo,
      fileId: uuidv7(),
      durationMs: 3000,
      decision: "confirmed",
    }));
    const placement: AdFacts["placements"][number] = {
      slot: "opening",
      adId,
      boundVersionNo: 1,
      ad,
    };
    const run = (p = placement, rows = versions) =>
      selectMaterialAdVersions({ entityId, storeId, placements: [p], versions: rows });
    expect(run()[0]).toMatchObject({ versionNo: 1, adVersionId: versions[0]!.id });
    expect(run({ ...placement, boundVersionNo: null })[0]).toMatchObject({
      versionNo: 2,
      adVersionId: versions[1]!.id,
    });
    expect(
      run(
        placement,
        versions.map((v) => ({ ...v, decision: null })),
      ),
    ).toEqual([]);
    expect(
      run(
        placement,
        versions.map((v) => ({ ...v, storeId: uuidv7() })),
      ),
    ).toEqual([]);
    expect(run({ ...placement, ad: { ...ad, status: "cancelled" } })).toEqual([]);
    expect(run(placement, [])).toEqual([]);
  });

  it("历史查询初始数据：真实读取closed包、撤销过期授权和三客户端日志，分页脱敏且GET零写", async () => {
    // Coordinator-approved historical read fixtures only. These rows never enter signing,
    // delivery, media or QC guards and do not claim the upstream package producer passed.
    const p = await parent(),
      other = await parent(),
      file = await h.stored();
    const now = h.clock.now(),
      createdAt = new Date(now.getTime() - 10 * 86_400_000);
    const closedAt = new Date(now.getTime() - 2 * 86_400_000);
    const release = await h.prisma.deliveryRelease.create({
      data: {
        id: uuidv7(),
        entityId: p.order.entityId,
        storeId: p.order.storeId,
        orderItemId: p.item.id,
        deliveryTicketId: p.ticket.id,
        releaseNo: 1,
        kind: "initial",
        state: "closed",
        episodeCount: 1,
        totalBytes: file.sizeBytes!,
        manifestSnapshot: [
          {
            episodeNo: 1,
            outputId: uuidv7(),
            fileId: file.id,
            name: "历史归档文件",
            size: file.sizeBytes!.toString(),
            crc64: "0",
          },
        ],
        checklistCode: "delivery.precheck",
        checklistVersionNo: 1,
        precheckResults: [],
        pushedByStaffId: h.staff.id,
        pushedAt: createdAt,
        closedAt,
        closeReason: "usage_ended",
        idempotencyKey: uuidv7(),
        createdAt,
        updatedAt: closedAt,
      },
    });
    const grant = await h.prisma.downloadGrant.create({
      data: {
        id: uuidv7(),
        entityId: p.order.entityId,
        storeId: p.order.storeId,
        orderItemId: p.item.id,
        deliveryReleaseId: release.id,
        granteeType: "entity",
        granteeId: p.order.entityId,
        state: "revoked",
        expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000),
        validDays: 7,
        actorType: "staff",
        actorId: h.staff.id,
        client: "admin",
        revokeReason: "历史授权已关闭",
        endedAt: closedAt,
        createdAt,
        updatedAt: closedAt,
      },
    });
    const common = {
      entityId: p.order.entityId,
      storeId: p.order.storeId,
      orderItemId: p.item.id,
      deliveryReleaseId: release.id,
      fileId: file.id,
      urlTtlSec: 900,
      ip: "192.0.2.42",
      userAgent: "private historical browser",
      createdAt,
    };
    const saved = await h.prisma.deliveryDownloadLog.create({
      data: {
        ...common,
        id: uuidv7(),
        kind: "episode",
        episodeNo: 1,
        actorType: "merchant",
        actorId: h.merchant.user.id,
        client: "weapp",
        downloadGrantId: grant.id,
        clientAck: "saved",
        clientAckAt: createdAt,
      },
    });
    const staffLog = await h.prisma.deliveryDownloadLog.create({
      data: {
        ...common,
        id: uuidv7(),
        kind: "episode",
        episodeNo: 1,
        actorType: "staff",
        actorId: h.staff.id,
        client: "admin",
      },
    });
    await h.prisma.deliveryDownloadLog.create({
      data: {
        ...common,
        id: uuidv7(),
        kind: "zip",
        actorType: "merchant",
        actorId: h.merchant.user.id,
        client: "portal",
        downloadGrantId: grant.id,
      },
    });
    const before = await snapshotTables(h.prisma, [...readTables, "delivery_release"]);
    const service = createDownloadRecords(h),
      staff = h.admin.staff!;
    const result = await service.list(staff, p.item.id, { page: 1, pageSize: 20 });
    expect(result.releases).toEqual([
      expect.objectContaining({
        deliveryReleaseId: release.id,
        state: "closed",
        savedEpisodeCount: 1,
      }),
    ]);
    expect(result.grants).toEqual([
      expect.objectContaining({ downloadGrantId: grant.id, state: "revoked", isExpired: true }),
    ]);
    expect(result.logs.total).toBe(3);
    expect(result.logs.items.map((l) => l.client)).toEqual(["portal", "admin", "weapp"]);
    expect(result.logs.items.find((l) => l.downloadId === staffLog.id)?.actorName).toBe(
      h.staff.name,
    );
    expect(result.logs.items.find((l) => l.downloadId === saved.id)?.clientAck).toBe("saved");
    expect(
      (
        await service.list(staff, p.item.id, {
          kind: "episode",
          episodeNo: 1,
          page: 2,
          pageSize: 1,
        })
      ).logs,
    ).toMatchObject({
      total: 2,
      page: 2,
      pageSize: 1,
      items: [expect.objectContaining({ downloadId: saved.id })],
    });
    expect((await service.list(staff, other.item.id, { page: 1, pageSize: 20 })).logs.total).toBe(
      0,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /192\.0\.2\.42|private historical browser|"seq"|"url"/u,
    );
    expect(await snapshotTables(h.prisma, [...readTables, "delivery_release"])).toEqual(before);
  });

  it("签名后文件被拦截时原子拒绝，不返回地址、不写访问和checkout", async () => {
    const p = await parent(),
      master = await committedMaster(p.drama.id),
      service = materials();
    const before = await snapshotTables(h.prisma, readTables),
      actual = h.media.signMaterialDownload.bind(h.media);
    const sign = vi.spyOn(h.media, "signMaterialDownload").mockImplementationOnce(async (input) => {
      const result = await actual(input);
      await h.prisma.fileObject.update({
        where: { id: input.fileId },
        data: { moderationState: "block" },
      });
      return result;
    });
    try {
      await expect(
        service.downloadUrls(h.admin.identity, h.admin.staff!, p.ticket.id, {
          kind: "master",
          episodeNos: [1],
        }),
      ).rejects.toMatchObject({ error: "MATERIAL_NOT_AVAILABLE" });
      expect(await snapshotTables(h.prisma, readTables)).toEqual(before);
      expect(await h.prisma.masterCheckout.count({ where: { orderItemId: p.item.id } })).toBe(0);
    } finally {
      sign.mockRestore();
      await h.prisma.fileObject.update({
        where: { id: master.fileId },
        data: { moderationState: "none" },
      });
    }
  });

  it("签名期间真实提交新原片版本时旧选择失效，不写旧版本checkout和访问", async () => {
    const p = await parent(),
      old = await committedMaster(p.drama.id),
      service = materials();
    const actual = h.media.signMaterialDownload.bind(h.media);
    const sign = vi.spyOn(h.media, "signMaterialDownload").mockImplementationOnce(async (input) => {
      const result = await actual(input);
      await committedMaster(p.drama.id);
      return result;
    });
    try {
      await expect(
        service.downloadUrls(h.admin.identity, h.admin.staff!, p.ticket.id, {
          kind: "master",
          episodeNos: [1],
        }),
      ).rejects.toMatchObject({
        error: "MATERIAL_NOT_AVAILABLE",
        details: { reason: "material_changed" },
      });
      expect(await h.prisma.masterCheckout.count({ where: { orderItemId: p.item.id } })).toBe(0);
      expect(
        await h.prisma.auditLog.count({ where: { stream: "access", targetId: old.fileId } }),
      ).toBe(0);
      expect(
        (await service.list(h.admin.identity, h.admin.staff!, p.ticket.id)).masters[0]?.revNo,
      ).toBe(2);
    } finally {
      sign.mockRestore();
    }
  });
});
