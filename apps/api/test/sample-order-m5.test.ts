import { beforeAll, describe, expect, it } from "vitest";
import {
  AdminSampleViewSchema,
  ChecklistItemsSchema,
  OrderActivityPageSchema,
  OrderQuoteResultSchema,
  SampleViewSchema,
  SampleWriteResultSchema,
} from "@liyoxi/contract";
import type { FileRegistration } from "@liyoxi/contract";
import { audit, createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import {
  createDeliveryProductionTools,
  createFactories,
  finishDeliveryProductionForTest,
  prepareDeliveryMasterForTest,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi,
  prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  foreign: SignedInMerchant,
  admin: SignedInStaff,
  editor: SignedInStaff,
  otherManager: SignedInStaff,
  denied: SignedInStaff,
  storeId: string,
  foreignStoreId: string,
  entityId: string,
  orderId: string,
  itemId: string,
  dramaId: string,
  ticketId: string,
  sampleId: string,
  planCode: string,
  screenshotId: string,
  foreignScreenshotId: string;
let peer = 0;
const feedback = { feedbackKind: "compose", note: "  片尾字幕请上移  " };
const operations = [
  "admin.order.activity.list",
  "admin.order.quote",
  "admin.sample.markSent",
  "m.sample.requestChange",
] as const;

function post(
  path: string,
  json: unknown,
  headers: Record<string, string> = admin.headers,
  key = uuidv7(),
) {
  return api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...headers, "Idempotency-Key": key },
    peer: `198.19.205.${++peer}`,
  });
}
function get(path: string, headers: Record<string, string> = admin.headers) {
  return api.request(`/api/v1${path}`, { headers, peer: `198.19.205.${++peer}` });
}
async function data<T = unknown>(response: Response, privateResult = true): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  if (privateResult) expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: T }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
async function checks() {
  const template = await prisma.checklistTemplate.findFirstOrThrow({
    where: { code: "qc.sample", status: "active" },
  });
  return {
    checklistVersionNo: template.versionNo,
    results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
      key,
      result: "pass" as const,
    })),
  };
}
async function writes() {
  return {
    sample: await prisma.sample.findMany({
      where: { deliveryTicketId: ticketId },
      orderBy: { id: "asc" },
    }),
    ticket: await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    history: await prisma.statusTransition.count(),
    audit: await prisma.auditLog.count({
      where: { stream: { in: ["activity", "access", "ops"] } },
    }),
    events: await prisma.outboxEvent.count(),
    refs: await prisma.fileRef.count(),
    timers: await prisma.timer.findMany({ orderBy: { id: "asc" } }),
    ledger: await prisma.pointLedgerEntry.count(),
    holds: await prisma.pointHold.findMany({ orderBy: { id: "asc" } }),
    orders: await prisma.dramaOrder.count(),
    stages: await prisma.deliveryTicketStage.findMany({
      where: { deliveryTicketId: ticketId },
      orderBy: { id: "asc" },
    }),
  };
}
async function uploadSample() {
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const registration = await data<FileRegistration>(
    await post(
      "/admin/files",
      {
        category: "sample_video",
        storeId,
        onBehalfStore: true,
        fileName: "W505-sample.mp4",
        sizeBytes: String(bytes.length),
        clientToken: uuidv7(),
        production: {
          kind: "sample",
          orderItemId: itemId,
          episodeNo: 1,
          aiUsage: { used: false, tools: [] },
        },
      },
      editor.headers,
    ),
    false,
  );
  const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: registration.fileId } });
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "media", key: file.incomingKey! },
    bytes,
    "video/mp4",
  );
  await data(await post(`/admin/files/${file.id}/complete`, {}, editor.headers), false);
  const promote = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.id}` },
  });
  await api.runtime.media.promote({ jobId: promote.id });
  const created = await data<{ sampleId: string }>(
    await post(
      `/admin/delivery-tickets/${ticketId}/samples`,
      {
        fileId: file.id,
        adSlots: [],
      },
      editor.headers,
    ),
  );
  await finishDeliveryProductionForTest(api.runtime, api.clock, file.id, true);
  await data(await post(`/admin/samples/${created.sampleId}/inspect`, await checks()));
  await data(await post(`/admin/samples/${created.sampleId}/push`, {}));
  return created.sampleId;
}
async function uploadScreenshot(actor: SignedInMerchant, store: string) {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    registration = await data<{ items: FileRegistration[] }>(
      await post(
        "/m/files",
        {
          category: "ticket_attachment",
          files: [
            {
              fileName: "W505-feedback.png",
              sizeBytes: String(bytes.length),
              clientToken: uuidv7(),
            },
          ],
        },
        actor.withStore(store),
      ),
      false,
    ),
    file = await prisma.fileObject.findUniqueOrThrow({
      where: { id: registration.items[0]!.fileId },
    });
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "asset", key: file.incomingKey! },
    bytes,
    "image/png",
  );
  await data(await post(`/m/files/${file.id}/complete`, {}, actor.withStore(store)), false);
  const promote = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.id}` },
  });
  await api.runtime.media.promote({ jobId: promote.id });
  return file.id;
}

beforeAll(async () => {
  api = await handle.start({
    mediaProduction: (providers) => {
      const tools = createDeliveryProductionTools(providers);
      return { config: tools.env, tools: tools.tools };
    },
  });
  prisma = await handle.db.prisma();
  make = createFactories({ db: prisma, clock: api.clock });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  clerk = await signInAsMerchant(api);
  foreign = await signInAsMerchant(api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  editor = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  otherManager = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  denied = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
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
      deliveryManagerId: admin.staff.id,
    }),
    member = await make.entityMember({
      entityId: entity.id,
      merchantUserId: owner.merchantUserId,
      role: "owner",
    }),
    clerkMember = await make.entityMember({
      entityId: entity.id,
      merchantUserId: clerk.merchantUserId,
    });
  entityId = entity.id;
  storeId = store.id;
  await make.storeMember({ entityMemberId: clerkMember.id, storeId, addedByMemberId: member.id });
  const otherEntity = await make.entity({
      createdByUserId: foreign.merchantUserId,
      verificationStatus: "verified",
    }),
    otherStore = await make.store({
      entityId: otherEntity.id,
      isPrimary: true,
      qualificationStatus: "verified",
    });
  foreignStoreId = otherStore.id;
  await make.entityMember({
    entityId: otherEntity.id,
    merchantUserId: foreign.merchantUserId,
    role: "owner",
  });
  const order = await make.dramaOrder({
      entityId,
      storeId,
      placedByUserId: owner.merchantUserId,
      deliveryManagerId: admin.staff.id,
      status: "producing",
    }),
    item = await make.orderItem({
      dramaOrderId: order.id,
      phase: "producing",
      episodeCount: 1,
      dramaSnapshot: { title: "W505真实样片反馈验收剧", allowedPlacements: [] },
    }),
    ticket = await make.deliveryTicket({
      orderItemId: item.id,
      step: "sample_making",
      deliveryManagerId: admin.staff.id,
      editorId: editor.staff.id,
    });
  orderId = order.id;
  planCode = order.planCode;
  itemId = item.id;
  dramaId = item.dramaId;
  ticketId = ticket.id;
  // Initial upstream order/stage only; files, production, QC, push and decisions use public writers.
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
  await prisma.drama.update({ where: { id: dramaId }, data: { synopsis: "W505虚构测试简介" } });
  await prepareDeliveryMasterForTest(api.runtime, prisma, {
    dramaId,
    episodeNo: 1,
    staffId: editor.staff.id,
  });
  sampleId = await uploadSample();
  screenshotId = await uploadScreenshot(owner, storeId);
  foreignScreenshotId = await uploadScreenshot(foreign, foreignStoreId);
}, 180_000);

describe("W5-05 四条真实HTTP与当前样片证据", { timeout: 60_000 }, () => {
  it("截图登记拒绝缺门店上下文、店员与跨店用户，不创建文件", async () => {
    const body = {
        category: "ticket_attachment",
        files: [{ fileName: "unauthorized.png", sizeBytes: "8", clientToken: uuidv7() }],
      },
      before = await prisma.fileObject.count();
    await error(await post("/m/files", body, owner.headers), 403, "NOT_A_MEMBER");
    await error(await post("/m/files", body, clerk.withStore(storeId)), 403, "ROLE_FORBIDDEN");
    await error(await post("/m/files", body, foreign.withStore(storeId)), 403, "NOT_A_MEMBER");
    expect(await prisma.fileObject.count()).toBe(before);
  });

  it("四个literal handler实际挂载，quote/activity鉴权与范围且GET不写业务或查看证据", async () => {
    for (const operationId of operations)
      expect(
        HANDLERS.some((handler) => handler.route.operationId === operationId),
        operationId,
      ).toBe(true);
    expect((await get(`/admin/orders/${orderId}/activities`, {})).status).toBe(401);
    expect((await post("/admin/orders/quote", { dramaId, planCode }, {})).status).toBe(401);
    await error(
      await post("/admin/orders/quote", { dramaId, planCode }, denied.headers),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await get(`/admin/orders/${orderId}/activities`, denied.headers),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await get(`/admin/orders/${orderId}/activities`, otherManager.headers),
      404,
      "NOT_FOUND",
    );
    await error(await get(`/admin/orders/${uuidv7()}/activities`), 404, "NOT_FOUND");
    await error(
      await post("/admin/orders/quote", { dramaId, planCode, entityId }),
      400,
      "VALIDATION_FAILED",
    );
    const before = await writes(),
      quote = OrderQuoteResultSchema.parse(
        await data(await post("/admin/orders/quote", { dramaId, planCode, isTopModel: false })),
      );
    expect(quote).toMatchObject({ dramaId, planCode, quotedAt: api.clock.now().toISOString() });
    expect(quote).not.toHaveProperty("ads");
    const page = OrderActivityPageSchema.parse(
      await data(await get(`/admin/orders/${orderId}/activities?limit=1`)),
    );
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const next = OrderActivityPageSchema.parse(
      await data(
        await get(`/admin/orders/${orderId}/activities?limit=1&cursor=${page.nextCursor}`),
      ),
    );
    expect(next.items[0]!.activityId).not.toBe(page.items[0]!.activityId);
    const view = SampleViewSchema.parse(
      await data(await get(`/m/order-items/${itemId}/sample`, owner.withStore(storeId))),
    );
    expect(view).toMatchObject({
      sampleId,
      versionNo: 1,
      firstViewedAt: null,
      viewedAckAt: null,
      decision: null,
      viewEvidence: { albumSavedAt: null, portalViewedAt: null },
    });
    expect(await writes()).toEqual(before);
  });

  it("markSent严格空体、权限/范围/幂等；发送登记不修改商家查看或确认", async () => {
    const path = `/admin/samples/${sampleId}/mark-sent`;
    expect((await post(path, {}, {})).status).toBe(401);
    await error(await post(path, {}, denied.headers), 403, "PERMISSION_DENIED");
    await error(await post(path, {}, otherManager.headers), 404, "NOT_FOUND");
    await error(await post(path, { hasViewed: true }), 400, "VALIDATION_FAILED");
    const key = uuidv7(),
      before = await writes(),
      sent = AdminSampleViewSchema.parse(await data(await post(path, {}, admin.headers, key)));
    expect(sent).toMatchObject({
      sampleId,
      status: "pushed",
      offlineSentAt: api.clock.now().toISOString(),
      firstViewedAt: null,
      viewedAckAt: null,
      decision: null,
      previewChannels: ["weapp"],
    });
    const after = await writes();
    expect(after.history).toBe(before.history);
    expect(after.events).toBe(before.events);
    expect(after.timers).toEqual(before.timers);
    const replay = AdminSampleViewSchema.parse(
      await data(await post(path, {}, admin.headers, key)),
    );
    expect(replay).toMatchObject({
      offlineSentAt: sent.offlineSentAt,
      preview: null,
      decision: null,
    });
    await data(await post(path, {}));
    expect(await writes()).toEqual(after);
    await error(
      await post(
        `/m/samples/${sampleId}/confirm`,
        { versionNo: 1, viewedVia: "wecom", hasViewed: true },
        owner.withStore(storeId),
      ),
      409,
      "SAMPLE_VIEW_CHANNEL_NOT_OFFERED",
    );
    await error(
      await post(
        `/m/samples/${sampleId}/confirm`,
        { versionNo: 1, viewedVia: "weapp", hasViewed: false },
        owner.withStore(storeId),
      ),
      400,
      "VALIDATION_FAILED",
    );
    const readBefore = await writes();
    await data(await get(`/m/order-items/${itemId}/sample`, owner.withStore(storeId)));
    expect(await writes()).toEqual(readBefore);
  });

  it("merchant compose严格body/店员/门店/截图守卫，同key只退回一次，新版读回且旧版本不能再反馈", async () => {
    const path = `/m/samples/${sampleId}/request-change`,
      headers = owner.withStore(storeId),
      body = { ...feedback, imageFileIds: [screenshotId] };
    expect((await post(path, body, {})).status).toBe(401);
    await error(await post(path, body, clerk.withStore(storeId)), 403, "ROLE_FORBIDDEN");
    await error(await post(path, body, foreign.withStore(foreignStoreId)), 404, "NOT_FOUND");
    const before = await writes();
    for (const invalid of [
      { ...body, feedbackKind: "ad_content" },
      { ...body, note: "  " },
      { ...body, note: "字".repeat(201) },
      { ...body, feedbackTimeMs: 100 },
      { ...body, feedback_time_ms: 100 },
      { ...body, adId: uuidv7() },
      { ...body, versionNo: 1 },
      { ...body, imageFileIds: [screenshotId, screenshotId] },
      { ...body, imageFileIds: Array.from({ length: 4 }, () => uuidv7()) },
    ])
      await error(await post(path, invalid, headers), 400, "VALIDATION_FAILED");
    await error(
      await post(path, { ...body, imageFileIds: [foreignScreenshotId] }, headers),
      400,
      "FILE_NOT_USABLE",
    );
    expect(await writes()).toEqual(before);
    const key = uuidv7(),
      changed = SampleWriteResultSchema.parse(await data(await post(path, body, headers, key)));
    expect(changed).toMatchObject({
      sampleId,
      status: "change_requested",
      ticketStep: "sample_making",
      sampleRoundNo: before.ticket.sampleRoundNo + 1,
      replayed: false,
      decision: { feedbackKind: "compose", feedbackNote: "片尾字幕请上移", isOnBehalf: false },
    });
    expect(changed.decision!.feedbackImages[0]!.url).toEqual(expect.any(String));
    const after = await writes(),
      replay = SampleWriteResultSchema.parse(await data(await post(path, body, headers, key)));
    expect(replay).toMatchObject({
      replayed: true,
      playable: null,
      decision: { feedbackImages: [{ fileId: screenshotId, url: null, expiresAt: null }] },
    });
    expect(await writes()).toEqual(after);
    expect(after.ledger).toBe(before.ledger);
    expect(after.holds).toEqual(before.holds);
    const stage = after.stages.find((row) => row.completedAt === null)!;
    expect(stage).toMatchObject({ step: "sample_making", visitNo: 2 });
    expect(stage.dueAt).not.toBeNull();
    expect(after.ticket.stepDueAt).toEqual(stage.dueAt);
    const nextId = await uploadSample();
    const readBefore = await writes(),
      current = SampleViewSchema.parse(
        await data(await get(`/m/order-items/${itemId}/sample`, headers)),
      );
    expect(current).toMatchObject({
      sampleId: nextId,
      versionNo: 2,
      firstViewedAt: null,
      viewedAckAt: null,
      offlineSentAt: null,
      decision: null,
    });
    expect(await writes()).toEqual(readBefore);
    await error(await post(path, body, headers), 409, "SAMPLE_VERSION_STALE");
    await error(
      await post(`/admin/samples/${sampleId}/mark-sent`, {}),
      409,
      "SAMPLE_VERSION_STALE",
    );
    await data(
      await post(
        `/m/samples/${nextId}/confirm`,
        { versionNo: 2, viewedVia: "weapp", hasViewed: true },
        headers,
      ),
    );
    const final = await prisma.sample.findUniqueOrThrow({ where: { id: nextId } });
    expect(final).toMatchObject({
      status: "confirmed",
      decidedByUserId: owner.merchantUserId,
      confirmViewedVia: "weapp",
    });
  });

  it("活动只来自本单及其真实子对象，不泄露同店其他订单或审计原始字段", async () => {
    const sibling = await make.dramaOrder({ entityId, storeId, status: "producing" }),
      ctx = createIdentityContext({
        actor: { type: "staff", id: admin.staff.id, client: "admin" },
      });
    await api.runtime.tx.run((tx) =>
      audit.record(
        tx,
        ctx.actor,
        {
          requestId: null,
          ip: null,
          userAgent: null,
          authMethod: null,
          sessionId: null,
        },
        {
          stream: "activity",
          category: "flow",
          action: "order.order.unrelated",
          summary: "同店另一单的虚构私有活动",
          target: { type: "drama_order", id: sibling.id },
          entityId,
          storeId,
          meta: { secret: "W505-do-not-project" },
        },
      ),
    );
    const before = await writes(),
      page = OrderActivityPageSchema.parse(
        await data(await get(`/admin/orders/${orderId}/activities?limit=50`)),
      );
    expect(
      page.items.some(
        (row) =>
          row.targetType === "sample" &&
          row.targetId === sampleId &&
          row.action === "delivery.sample.mark_sent",
      ),
    ).toBe(true);
    expect(page.items.some((row) => row.targetId === sibling.id)).toBe(false);
    expect(JSON.stringify(page)).not.toContain("W505-do-not-project");
    expect(
      page.items.every(
        (row) =>
          !Object.hasOwn(row, "payload") &&
          !Object.hasOwn(row, "meta") &&
          !Object.hasOwn(row, "ip"),
      ),
    ).toBe(true);
    expect(await writes()).toEqual(before);
    await error(
      await get(`/admin/orders/${orderId}/activities?cursor=invalid`),
      400,
      "VALIDATION_FAILED",
    );
  });
});
