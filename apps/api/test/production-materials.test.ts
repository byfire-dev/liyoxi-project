import { beforeAll, describe, expect, it } from "vitest";
import type {
  FileRegistration,
  MaterialDownloadResult,
  ProductionJobAccepted,
  ProductionRecordView,
} from "@liyoxi/contract";
import {
  createFactories,
  createDeliveryProductionTools,
  finishDeliveryProductionForTest,
  prepareDeliveryMasterForTest,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi,
  prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  admin: SignedInStaff,
  editor: SignedInStaff,
  otherEditor: SignedInStaff,
  owner: SignedInMerchant,
  ticketId: string,
  itemId: string,
  sourceId: string,
  profileFileId: string,
  outputId: string;
let peer = 0;
async function result<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: T }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
function post(path: string, body: unknown, actor = admin, key = uuidv7()) {
  return api.request(`/api/v1/admin${path}`, {
    method: "POST",
    json: body,
    headers: { ...actor.headers, "Idempotency-Key": key },
    peer: `198.19.54.${++peer}`,
  });
}
function get(path: string, actor = admin) {
  return api.request(`/api/v1/admin${path}`, {
    headers: actor.headers,
    peer: `198.19.54.${++peer}`,
  });
}
async function upload(
  storeId: string,
  category: string,
  bytes: Uint8Array,
  ext: string,
  production?: unknown,
) {
  const merchant = category === "profile_image";
  const draft = { fileName: `W504.${ext}`, sizeBytes: String(bytes.length), clientToken: uuidv7() };
  const response = merchant
    ? await api.request("/api/v1/m/files", {
        method: "POST",
        json: { category, files: [draft] },
        headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
        peer: `198.19.54.${++peer}`,
      })
    : await post("/files", {
        category,
        storeId,
        onBehalfStore: true,
        ...draft,
        ...(production ? { production } : {}),
      });
  expect(response.status, await response.clone().text()).toBe(200);
  const payload = (
    (await response.json()) as { data: FileRegistration | { items: FileRegistration[] } }
  ).data;
  const registration = "items" in payload ? payload.items[0]! : payload;
  const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: registration.fileId } });
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: file.incomingBucket as "asset" | "media", key: file.incomingKey! },
    bytes,
    ext === "mp4" ? "video/mp4" : "image/png",
  );
  const completed = merchant
    ? await api.request(`/api/v1/m/files/${file.id}/complete`, {
        method: "POST",
        json: {},
        headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
        peer: `198.19.54.${++peer}`,
      })
    : await post(`/files/${file.id}/complete`, {});
  expect(completed.status, await completed.clone().text()).toBe(200);
  const promote = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.id}` },
  });
  await api.runtime.media.promote({ jobId: promote.id });
  return file.id;
}
async function probe(fileId: string) {
  const jobId = await api.runtime.tx.run((tx) => api.runtime.media.enqueueProbe(tx, fileId));
  await api.runtime.media.jobs.run({ jobId });
}
beforeAll(async () => {
  api = await handle.start({
    mediaProduction: (providers) => {
      const codec = createDeliveryProductionTools(providers);
      return { config: codec.env, tools: codec.tools };
    },
  });
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  editor = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  otherEditor = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  const make = createFactories({ db: prisma, clock: api.clock }),
    entity = await make.entity({
      createdByUserId: owner.merchantUserId,
      verificationStatus: "verified",
    }),
    store = await make.store({
      entityId: entity.id,
      qualificationStatus: "verified",
      isPrimary: true,
    }),
    member = await make.entityMember({
      entityId: entity.id,
      merchantUserId: owner.merchantUserId,
      role: "owner",
    }),
    order = await make.dramaOrder({
      status: "producing",
      entityId: entity.id,
      storeId: store.id,
      placedByUserId: owner.merchantUserId,
    }),
    item = await make.orderItem({
      dramaOrderId: order.id,
      phase: "producing",
      episodeCount: 1,
      dramaSnapshot: { title: "虚构W504接口剧", allowedPlacements: [] },
    }),
    ticket = await make.deliveryTicket({
      orderItemId: item.id,
      step: "batch_compose",
      editorId: editor.staff.id,
    });
  itemId = item.id;
  ticketId = ticket.id;
  const master = await prepareDeliveryMasterForTest(api.runtime, prisma, {
    dramaId: item.dramaId,
    episodeNo: 1,
    staffId: admin.staff.id,
  });
  const video = new Uint8Array(1234);
  video.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  sourceId = await upload(order.storeId, "final_episode", video, "mp4", {
    kind: "final",
    orderItemId: item.id,
    episodeNo: 1,
    dramaEpisodeMasterId: master.id,
    aiUsage: { used: false, tools: [] },
  });
  await probe(sourceId);
  expect(
    await prisma.productionRecord.findUniqueOrThrow({ where: { fileId: sourceId } }),
  ).toMatchObject({ pipelineState: "ready" });
  const registeredResponse = await post(`/delivery-tickets/${ticketId}/episode-outputs`, {
    items: [{ episodeNo: 1, fileId: sourceId }],
  });
  expect(registeredResponse.status, await registeredResponse.clone().text()).toBe(200);
  const registered = (
    (await registeredResponse.json()) as { data: { items: Array<{ episodeOutputId: string }> } }
  ).data;
  outputId = registered.items[0]!.episodeOutputId;
  profileFileId = await upload(
    order.storeId,
    "profile_image",
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    "png",
  );
  expect(member.role).toBe("owner");
  const mediaPatch = async (lockVersion: number, groups: unknown) => {
    const response = await api.request("/api/v1/m/store-profile/media", {
      method: "PATCH",
      json: { draft: true, lockVersion, groups },
      headers: { ...owner.withStore(order.storeId), "Idempotency-Key": uuidv7() },
      peer: `198.19.54.${++peer}`,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const before = await prisma.storeProfile.findUnique({ where: { storeId: order.storeId } });
  await mediaPatch(before?.lockVersion ?? 0, { product: [{ fileId: profileFileId }] });
  // Explicit historical profile association only: the order has no profile-media input.
  await prisma.fileRef.create({
    data: {
      id: uuidv7(),
      fileId: profileFileId,
      refType: "drama_order",
      refId: order.id,
      role: "reference",
      state: "live",
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  const current = await prisma.storeProfile.findUniqueOrThrow({
    where: { storeId: order.storeId },
  });
  await mediaPatch(current.lockVersion, { product: [] });
}, 180_000);

describe("W5-04 七条真实HTTP", () => {
  it("事实只读、真实父范围与本人任务，不泄露原始探测输出", async () => {
    for (const id of [
      "admin.productionRecord.list",
      "admin.productionRecord.normalize",
      "admin.productionRecord.restamp",
      "admin.productionRecord.recheck",
      "admin.deliveryTicket.material.list",
      "admin.deliveryTicket.material.downloadUrls",
      "admin.orderItem.download.list",
    ])
      expect(
        HANDLERS.some((h) => h.route.operationId === id),
        id,
      ).toBe(true);
    await error(await get("/production-records"), 400, "VALIDATION_FAILED");
    const before = {
      audit: await prisma.auditLog.count(),
      checkout: await prisma.masterCheckout.count(),
      jobs: await prisma.mediaJob.count(),
    };
    const page = await result<{ items: ProductionRecordView[]; total: number }>(
      await get(`/production-records?fileIds=${sourceId}`),
    );
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ productionRecordId: sourceId, pipelineState: "ready" });
    expect(JSON.stringify(page)).not.toContain('"raw"');
    expect(
      await result<{ total: number }>(
        await get(`/production-records?orderItemId=${itemId}`, otherEditor),
      ),
    ).toMatchObject({ total: 0 });
    await error(
      await get(`/delivery-tickets/${ticketId}/materials`, otherEditor),
      404,
      "NOT_FOUND",
    );
    await result(await get(`/delivery-tickets/${ticketId}/materials`, editor));
    const history = await result<{
      releases: unknown[];
      grants: unknown[];
      logs: { total: number };
    }>(await get(`/order-items/${itemId}/downloads`));
    expect(history).toMatchObject({ releases: [], grants: [], logs: { total: 0 } });
    expect({
      audit: await prisma.auditLog.count(),
      checkout: await prisma.masterCheckout.count(),
      jobs: await prisma.mediaJob.count(),
    }).toEqual(before);
  });

  it("人工规格化、补标、重检沿真实任务，进行中重用且不自动采纳", async () => {
    const original = await prisma.productionRecord.findUniqueOrThrow({
        where: { fileId: sourceId },
      }),
      key = uuidv7();
    const normalized = await result<ProductionJobAccepted>(
      await post(`/production-records/${sourceId}/normalize`, {}, admin, key),
    );
    expect(normalized).toMatchObject({
      sourceFileId: sourceId,
      pipelineState: "uploading",
      jobKind: "normalize",
      jobState: "queued",
    });
    expect(normalized.productionRecordId).not.toBe(sourceId);
    expect(
      await result(await post(`/production-records/${sourceId}/normalize`, {}, admin, key)),
    ).toEqual(normalized);
    expect(await result(await post(`/production-records/${sourceId}/normalize`, {}))).toEqual(
      normalized,
    );
    await api.runtime.media.jobs.run({ jobId: normalized.mediaJobId });
    api.clock.advance(5000);
    await api.runtime.media.jobs.run({ jobId: normalized.mediaJobId });
    await probe(normalized.productionRecordId);
    expect(
      await prisma.productionRecord.findUniqueOrThrow({
        where: { fileId: normalized.productionRecordId },
      }),
    ).toMatchObject({ pipelineState: "ready", derivedFromFileId: sourceId, source: "normalized" });
    const stamped = await result<ProductionJobAccepted>(
      await post(`/production-records/${sourceId}/restamp`, {
        tools: [{ name: "测试工具", version: "1", usedFor: "辅助剪辑" }],
        note: "更正原声明",
      }),
    );
    await api.runtime.media.jobs.run({ jobId: stamped.mediaJobId });
    await finishDeliveryProductionForTest(api.runtime, api.clock, stamped.productionRecordId);
    expect(
      await prisma.productionRecord.findUniqueOrThrow({
        where: { fileId: stamped.productionRecordId },
      }),
    ).toMatchObject({
      pipelineState: "ready",
      aigcState: "verified",
      aiUsage: { used: true, declaredBy: admin.staff.id },
    });
    expect(
      (await prisma.productionRecord.findUniqueOrThrow({ where: { fileId: sourceId } })).aiUsage,
    ).toEqual(original.aiUsage);
    const checked = await result<ProductionJobAccepted>(
      await post(`/production-records/${sourceId}/recheck`, {}),
    );
    expect(checked).toMatchObject({
      productionRecordId: sourceId,
      pipelineState: "checking",
      jobKind: "probe",
    });
    await api.runtime.media.jobs.run({ jobId: checked.mediaJobId });
    expect(
      (await prisma.productionRecord.findUniqueOrThrow({ where: { fileId: sourceId } }))
        .pipelineState,
    ).toBe("ready");
    expect(await prisma.episodeOutput.count({ where: { deliveryTicketId: ticketId } })).toBe(1);
    expect(await prisma.episodeOutput.findUniqueOrThrow({ where: { id: outputId } })).toMatchObject(
      { fileId: sourceId, status: "uploaded", isCurrent: false },
    );
    expect(
      await prisma.episodeOutput.count({ where: { fileId: stamped.productionRecordId } }),
    ).toBe(0);
    await error(
      await post(`/production-records/${sourceId}/normalize`, {}, otherEditor),
      403,
      "PERMISSION_DENIED",
    );
  });

  it("取料30分钟逐份审计，已移除档案媒体按订单保留引用可取，短地址不入幂等", async () => {
    const key = uuidv7(),
      before = await prisma.auditLog.count({
        where: { stream: "access", targetId: profileFileId },
      });
    const first = await result<MaterialDownloadResult>(
      await post(
        `/delivery-tickets/${ticketId}/materials/download-urls`,
        { kind: "profile_media", fileId: profileFileId },
        editor,
        key,
      ),
    );
    expect(first.items).toHaveLength(1);
    expect(new Date(first.items[0]!.expiresAt).getTime() - api.clock.now().getTime()).toBe(
      1_800_000,
    );
    api.clock.advance(2000);
    const second = await result<MaterialDownloadResult>(
      await post(
        `/delivery-tickets/${ticketId}/materials/download-urls`,
        { kind: "profile_media", fileId: profileFileId },
        editor,
        key,
      ),
    );
    expect(second.items[0]!.expiresAt).not.toBe(first.items[0]!.expiresAt);
    expect(
      await prisma.auditLog.count({ where: { stream: "access", targetId: profileFileId } }),
    ).toBe(before + 2);
    expect(
      await prisma.idempotencyRecord.count({
        where: { scope: "admin.deliveryTicket.material.downloadUrls", key },
      }),
    ).toBe(0);
    expect(JSON.stringify(await prisma.idempotencyRecord.findMany())).not.toContain(
      first.items[0]!.url,
    );
    await error(
      await post(`/delivery-tickets/${ticketId}/materials/download-urls`, {
        kind: "profile_media",
        fileId: uuidv7(),
      }),
      409,
      "MATERIAL_NOT_AVAILABLE",
    );
    await error(
      await post(`/delivery-tickets/${ticketId}/materials/download-urls`, {
        kind: "ad_version",
        adVersionId: uuidv7(),
      }),
      409,
      "MATERIAL_NOT_AVAILABLE",
    );
    await error(
      await post(`/delivery-tickets/${ticketId}/materials/download-urls`, {
        kind: "master",
        episodeNos: [2],
      }),
      400,
      "VALIDATION_FAILED",
    );
  });
});
