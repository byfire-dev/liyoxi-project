// 真 handler/鉴权/幂等链；旧渠道快照是历史夹具，制作和水印由正式 fake 媒体工具完成。
import { beforeAll, expect, it } from "vitest";
import { ChecklistItemsSchema, defaultRoleActions } from "@liyoxi/contract";
import type { SampleInspectBody } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createDeliveryProductionTools,
  createFactories,
  finishDeliveryProductionForTest,
  prepareDeliveryMasterForTest,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi,
  prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  owner: SignedInMerchant,
  editor: SignedInStaff,
  qc: SignedInStaff,
  pushOnly: SignedInStaff,
  ticketId: string,
  itemId: string,
  storeId: string,
  fileId: string;
let peer = 0;

function post(
  path: string,
  json: unknown,
  headers: Record<string, string> = qc.headers,
  key = uuidv7(),
) {
  return api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...headers, "Idempotency-Key": key },
    peer: `198.19.129.${++peer}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}
async function error(response: Response, status: number, code: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: code });
}
async function checks(): Promise<SampleInspectBody> {
  const template = await prisma.checklistTemplate.findFirstOrThrow({
    where: { code: "qc.sample", status: "active" },
  });
  return {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
      key,
      result: "pass",
    })),
  };
}
async function domainWrites() {
  return [
    await prisma.sample.count({ where: { deliveryTicketId: ticketId } }),
    await prisma.qcRecord.count({ where: { deliveryTicketId: ticketId } }),
    await prisma.statusTransition.count(),
    await prisma.outboxEvent.count(),
    await prisma.auditLog.count({ where: { stream: "activity", category: "delivery" } }),
  ];
}

beforeAll(async () => {
  api = await handle.start({
    mediaProduction: (providers) => {
      const external = createDeliveryProductionTools(providers);
      return { config: external.env, tools: external.tools };
    },
  });
  prisma = await handle.db.prisma();
  const make = createFactories({ db: prisma, clock: api.clock });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  editor = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  qc = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  await prisma.staffRole.update({
    where: { key: "delivery_manager" },
    data: {
      dataScope: "all",
      actions: {
        ...defaultRoleActions("delivery_manager"),
        "delivery.sample.qc": { on: false, leadOnly: false },
      },
    },
  });
  pushOnly = await signInAsStaff(prisma, {
    roleKey: "delivery_manager",
    now: api.clock.now(),
  });
  await prisma.featureFlag.upsert({
    where: { key: "weapp.video.sample.enabled" },
    update: { defaultValue: true, rules: [] },
    create: {
      key: "weapp.video.sample.enabled",
      valueType: "bool",
      defaultValue: true,
      exposedTo: "client",
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  await api.runtime.config.cache.bump("flag");
  const entity = await make.entity({
      createdByUserId: owner.merchantUserId,
      verificationStatus: "verified",
    }),
    store = await make.store({
      entityId: entity.id,
      isPrimary: true,
      qualificationStatus: "verified",
    });
  storeId = store.id;
  await make.entityMember({
    entityId: entity.id,
    merchantUserId: owner.merchantUserId,
    role: "owner",
  });
  const order = await make.dramaOrder({ entityId: entity.id, storeId, status: "producing" }),
    item = await make.orderItem({
      dramaOrderId: order.id,
      phase: "producing",
      dramaSnapshot: { title: "历史样片恢复验收剧" },
    });
  itemId = item.id;
  await prepareDeliveryMasterForTest(api.runtime, prisma, {
    dramaId: item.dramaId,
    episodeNo: 1,
    staffId: editor.staff.id,
  });
  const ticket = await make.deliveryTicket({ orderItemId: itemId, step: "sample_making" });
  ticketId = ticket.id;
  await prisma.deliveryTicketStage.create({
    data: {
      id: uuidv7(),
      deliveryTicketId: ticketId,
      step: "sample_making",
      visitNo: 1,
      enteredAt: api.clock.now(),
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  const file = await make.fileObject({
    category: "sample_video",
    scopeType: "store",
    entityId: entity.id,
    storeId,
    bucket: "media",
    ext: "mp4",
    mime: "video/mp4",
    declaredMime: "video/mp4",
    uploadActorType: "staff",
    uploadActorId: editor.staff.id,
    uploadClient: "admin",
  });
  fileId = file.id;
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const etag = (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "media", key: file.objectKey },
    bytes,
    "video/mp4",
  );
  await prisma.fileObject.update({
    where: { id: fileId },
    data: { sizeBytes: bytes.length, declaredSize: bytes.length, etag },
  });
}, 180_000);

it("显式恢复历史快照生成新版和独立 QC；并发/重放只一版，商家确认仍需查看勾选", async () => {
  const created = await data(
    await post(
      `/admin/delivery-tickets/${ticketId}/samples`,
      { fileId, adSlots: [] },
      editor.headers,
    ),
  );
  const oldId = created.sampleId as string;
  await finishDeliveryProductionForTest(api.runtime, api.clock, fileId, true);
  await data(await post(`/admin/samples/${oldId}/inspect`, await checks()));
  await data(await post(`/admin/samples/${oldId}/push`, {}));
  // 只模拟上线前持久化的渠道/查看事实，不伪造生产或质检通过事实。
  const source = await prisma.sample.update({
    where: { id: oldId },
    data: {
      previewChannels: ["album", "portal", "wecom"],
      firstViewedAt: api.clock.now(),
      offlineSentAt: api.clock.now(),
      offlineSentByStaffId: qc.staff.id,
    },
  });
  const oldQc = await prisma.qcRecord.findUniqueOrThrow({ where: { id: source.qcRecordId! } }),
    beforeTicket = await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    stages = await prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: ticketId },
      orderBy: { id: "asc" },
    }),
    body = {
      legacyRecovery: {
        versionNo: 1,
        reason: "历史样片迁移为小程序查看",
        quality: await checks(),
      },
    },
    beforeRejected = await domainWrites();

  await error(await post(`/admin/samples/${oldId}/push`, {}), 409, "STATE_NOT_ALLOWED");
  await error(
    await post(`/admin/samples/${oldId}/push`, {
      legacyRecovery: { versionNo: 1, reason: body.legacyRecovery.reason },
    }),
    400,
    "VALIDATION_FAILED",
  );
  await error(
    await post(`/admin/samples/${oldId}/push`, body, editor.headers),
    409,
    "QC_SELF_INSPECTION",
  );
  await error(
    await post(`/admin/samples/${oldId}/push`, body, pushOnly.headers),
    403,
    "PERMISSION_DENIED",
  );
  expect(await domainWrites()).toEqual(beforeRejected);
  expect(await prisma.sample.findUniqueOrThrow({ where: { id: oldId } })).toEqual(source);

  const keys = [uuidv7(), uuidv7()],
    attempts = await Promise.all(
      keys.map((key) => post(`/admin/samples/${oldId}/push`, body, qc.headers, key)),
    );
  expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = attempts.findIndex((r) => r.status === 200),
    restored = await data(attempts[winner]!);
  const newId = restored.sampleId as string;
  expect(newId).not.toBe(oldId);
  expect(restored).toMatchObject({
    versionNo: 2,
    status: "pushed",
    fileId,
    previewChannels: ["weapp"],
    preview: { url: expect.stringContaining("https://") },
    replayed: false,
  });
  const afterRecovery = await domainWrites();
  expect(afterRecovery.slice(0, 2)).toEqual([2, 2]);
  expect(
    await data(await post(`/admin/samples/${oldId}/push`, body, qc.headers, keys[winner]!)),
  ).toMatchObject({ sampleId: newId, versionNo: 2, replayed: true, preview: null });
  expect(await domainWrites()).toEqual(afterRecovery);
  const cached = await prisma.idempotencyRecord.findFirstOrThrow({
    where: { scope: "admin.sample.push", key: keys[winner]! },
  });
  expect(cached.result).toMatchObject({ sampleId: newId, versionNo: 2, preview: null });
  expect(JSON.stringify(cached.result)).not.toContain("https://");

  const old = await prisma.sample.findUniqueOrThrow({ where: { id: oldId } }),
    current = await prisma.sample.findUniqueOrThrow({ where: { id: newId } }),
    currentQc = await prisma.qcRecord.findUniqueOrThrow({ where: { id: current.qcRecordId! } }),
    currentTicket = await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } });
  expect(old).toMatchObject({
    status: "superseded",
    previewChannels: source.previewChannels,
    pushedAt: source.pushedAt,
    pushedByStaffId: source.pushedByStaffId,
    firstViewedAt: source.firstViewedAt,
    offlineSentAt: source.offlineSentAt,
    offlineSentByStaffId: source.offlineSentByStaffId,
    qcRecordId: oldQc.id,
  });
  expect(await prisma.qcRecord.findUniqueOrThrow({ where: { id: oldQc.id } })).toEqual(oldQc);
  expect(current).toMatchObject({
    uploadedByStaffId: source.uploadedByStaffId,
    uploadedAt: source.uploadedAt,
    fileId: source.fileId,
    adSlots: source.adSlots,
    adVersionsUsed: source.adVersionsUsed,
    firstViewedAt: null,
    offlineSentAt: null,
    offlineSentByStaffId: null,
    viewedAckAt: null,
    viewedAckByUserId: null,
    decidedAt: null,
    decidedByUserId: null,
    decideClient: null,
    confirmViewedVia: null,
    onBehalfStaffId: null,
    feedbackKind: null,
    feedbackNote: null,
    feedbackTimeMs: null,
    feedbackFileIds: [],
  });
  expect(currentQc.id).not.toBe(oldQc.id);
  expect(currentQc).toMatchObject({
    targetType: "sample",
    targetId: newId,
    deliveryTicketId: ticketId,
    checklistCode: "qc.sample",
    checklistVersionNo: body.legacyRecovery.quality.checklistVersionNo,
    verdict: "pass",
    inspectedByStaffId: qc.staff.id,
  });
  const recoveryAudit = await prisma.auditLog.findMany({
    where: { action: "delivery.sample.legacy_recovered", targetId: newId },
  });
  expect(recoveryAudit).toHaveLength(1);
  expect(recoveryAudit[0]).toMatchObject({
    actorType: "staff",
    actorId: qc.staff.id,
    before: { sampleId: oldId, versionNo: 1, previewChannels: source.previewChannels },
    after: { sampleId: newId, versionNo: 2, previewChannels: ["weapp"] },
    meta: {
      reason: body.legacyRecovery.reason,
      sourceQcRecordId: oldQc.id,
      qcRecordId: currentQc.id,
      fileId,
    },
  });
  expect(currentTicket).toMatchObject({
    step: "sample_confirm",
    currentSampleVersionNo: 2,
    stepEnteredAt: beforeTicket.stepEnteredAt,
    sampleFirstPushedAt: beforeTicket.sampleFirstPushedAt,
    sampleRoundNo: beforeTicket.sampleRoundNo,
  });
  expect(
    await prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: ticketId },
      orderBy: { id: "asc" },
    }),
  ).toEqual(stages);

  const oldAgain = await post(`/admin/samples/${oldId}/push`, body);
  expect(oldAgain.status, await oldAgain.clone().text()).toBe(409);
  await error(
    await post(
      `/m/samples/${oldId}/confirm`,
      { versionNo: 1, viewedVia: "weapp", hasViewed: true },
      owner.withStore(storeId),
    ),
    409,
    "SAMPLE_VERSION_STALE",
  );
  await error(
    await post(
      `/m/samples/${newId}/confirm`,
      { versionNo: 2, viewedVia: "weapp", hasViewed: false },
      owner.withStore(storeId),
    ),
    400,
    "VALIDATION_FAILED",
  );
  expect(await domainWrites()).toEqual(afterRecovery);
  expect(await prisma.sample.findUniqueOrThrow({ where: { id: newId } })).toEqual(current);
  const merchant = await data(
    await api.request(`/api/v1/m/order-items/${itemId}/sample`, {
      headers: owner.withStore(storeId),
      peer: `198.19.129.${++peer}`,
    }),
  );
  expect(merchant).toMatchObject({
    sampleId: newId,
    versionNo: 2,
    status: "pushed",
    previewChannels: ["weapp"],
    confirmableVia: ["weapp"],
    decision: null,
    playable: { sources: [{ url: expect.stringContaining("https://") }] },
    actions: ["confirm"],
  });
}, 120_000);
