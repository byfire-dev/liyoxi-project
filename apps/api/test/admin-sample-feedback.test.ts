import { beforeAll, describe, expect, it } from "vitest";
import { AdminSampleViewSchema, ChecklistItemsSchema } from "@liyoxi/contract";
import type { FileRegistration } from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import {
  createDeliveryProductionTools,
  createFactories,
  createW508OrderAdFixture,
  finishDeliveryProductionForTest,
  prepareDeliveryMasterForTest,
  prepareOrderFixture,
  sampleStaffContext,
  signInAsStaff,
  snapshotTables,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { deliveryOf } from "../src/routes/delivery.js";
import { deliveryM5Of } from "../src/routes/admin/delivery-m5.js";
import { HANDLERS } from "../src/routes/index.js";

const h = useTestApi();
let api: TestApi,
  prisma: Awaited<ReturnType<typeof h.db.prisma>>,
  admin: SignedInStaff,
  editor: SignedInStaff,
  denied: SignedInStaff,
  outsider: SignedInStaff,
  sampleId: string,
  ticketId: string,
  storeId: string,
  itemId: string,
  merchantScreenshotId: string;
let peer = 0;
const post = (path: string, json: unknown, who = admin, key = uuidv7()) =>
  api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...who.headers, "Idempotency-Key": key },
    peer: `198.19.208.${++peer % 250}`,
  });
async function data<T>(r: Response): Promise<T> {
  expect(
    r.status,
    `${await r.clone().text()} ${r.status >= 500 ? JSON.stringify(api.logs.filter((row) => row.evt === "http.error").map((row) => row.err)) : ""}`,
  ).toBe(200);
  return ((await r.json()) as { data: T }).data;
}
async function fail(r: Response, status: number, error: string) {
  expect(r.status, await r.clone().text()).toBe(status);
  expect(await r.json()).toMatchObject({ error });
}
const evidence = () =>
  snapshotTables(prisma, [
    "sample",
    "delivery_ticket",
    "delivery_ticket_stage",
    "ad_revision",
    "ledger_operation",
    "point_hold",
    "status_transition",
    "outbox_event",
    "file_ref",
  ]);

beforeAll(async () => {
  api = await h.start({
    mediaProduction: (providers) => {
      const tools = createDeliveryProductionTools(providers);
      return { config: tools.env, tools: tools.tools };
    },
  });
  prisma = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  const owner = await signInAsMerchant(api),
    make = createFactories({ db: prisma, clock: api.clock });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  editor = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  denied = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  outsider = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  const entity = await make.entity({ createdByUserId: owner.merchantUserId }),
    store = await make.store({ entityId: entity.id, isPrimary: true }),
    member = await make.entityMember({
      entityId: entity.id,
      merchantUserId: owner.merchantUserId,
      role: "owner",
    });
  storeId = store.id;
  merchantScreenshotId = (
    await make.fileObject({
      category: "ticket_attachment",
      bucket: "asset",
      entityId: entity.id,
      storeId,
      scopeType: "store",
      uploadActorType: "merchant",
      uploadActorId: owner.merchantUserId,
      uploadClient: "weapp",
    })
  ).id;
  const fixture = await prepareOrderFixture(prisma, api.runtime, api.clock, {
    entityId: entity.id,
    storeId,
    merchantUserId: owner.merchantUserId,
    memberId: member.id,
  });
  const created = await api.runtime.order.create(fixture.actor, fixture.input),
    timer = await prisma.timer.findFirstOrThrow({
      where: { kind: "order.start", subjectId: created.orderId },
    });
  api.clock.set(timer.fireAt);
  const handler = api.runtime.assembly.timerHandler("order.start")!;
  await api.runtime.tx.run((tx) =>
    handler.handle(tx, {
      id: timer.id,
      kind: timer.kind,
      subjectType: timer.subjectType,
      subjectId: timer.subjectId,
      payload: timer.payload as Record<string, unknown>,
    }),
  );
  const ticket = await prisma.deliveryTicket.findFirstOrThrow({
      where: { dramaOrderId: created.orderId },
    }),
    staff = await sampleStaffContext(prisma, admin.staff.id, { stepUpAt: api.clock.now() }),
    ctx = createIdentityContext({ actor: { type: "staff", id: admin.staff.id, client: "admin" } }),
    service = deliveryOf(api.runtime);
  ticketId = ticket.id;
  itemId = ticket.orderItemId;
  const manager = await make.staff({ staffRoleKey: "delivery_manager" });
  await service.assign(ctx, staff, ticketId, { staffId: manager.id });
  await deliveryM5Of(api.runtime).assignEditor(ctx, staff, ticketId, { staffId: editor.staff.id });
  const plan = await prisma.deliveryPlan.findUniqueOrThrow({
    where: { dramaOrderId: created.orderId },
  });
  await service.replaceDraft(ctx, staff, plan.id, {
    draftLockVersion: plan.draftLockVersion,
    content: {
      focusCodes: ["W115F"],
      referenceAssetIds: [],
      launchMode: "merchant_self",
      note: "后台反馈真实订购",
      items: [
        {
          orderItemId: itemId,
          channelAccountIds: [fixture.channelAccountId],
          placements: [],
          agreedLaunchDate: "2030-01-01",
          expectedDeliveryDate: null,
        },
      ],
    },
  });
  await service.push(ctx, staff, plan.id, { draftLockVersion: plan.draftLockVersion + 1 });
  await service.confirm(fixture.actor, plan.id, { versionNo: 1 });
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
  await prepareDeliveryMasterForTest(api.runtime, prisma, {
    dramaId: ticket.dramaId,
    episodeNo: 1,
    staffId: editor.staff.id,
  });
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
  const registered = await data<FileRegistration>(
    await post(
      "/admin/files",
      {
        category: "sample_video",
        storeId,
        onBehalfStore: true,
        fileName: "w508-sample.mp4",
        sizeBytes: String(bytes.length),
        clientToken: uuidv7(),
        production: {
          kind: "sample",
          orderItemId: itemId,
          episodeNo: 1,
          aiUsage: { used: false, tools: [] },
        },
      },
      editor,
    ),
  );
  const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: registered.fileId } });
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "media", key: file.incomingKey! },
    bytes,
    "video/mp4",
  );
  await data(await post(`/admin/files/${file.id}/complete`, {}, editor));
  const job = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.id}` },
  });
  await api.runtime.media.promote({ jobId: job.id });
  const result = await data<{ sampleId: string }>(
    await post(
      `/admin/delivery-tickets/${ticketId}/samples`,
      { fileId: file.id, adSlots: [] },
      editor,
    ),
  );
  sampleId = result.sampleId;
  await finishDeliveryProductionForTest(api.runtime, api.clock, file.id, true);
  const qc = await prisma.checklistTemplate.findFirstOrThrow({
    where: { code: "qc.sample", status: "active" },
  });
  await data(
    await post(`/admin/samples/${sampleId}/inspect`, {
      checklistVersionNo: qc.versionNo,
      results: ChecklistItemsSchema.parse(qc.items).map(({ key }) => ({ key, result: "pass" })),
    }),
  );
  await data(await post(`/admin/samples/${sampleId}/push`, {}));
}, 180_000);

describe("W5-08 后台样片反馈真实HTTP", { timeout: 60_000 }, () => {
  it("所属API真实挂载，角色/范围/版本/错误广告和strict双分支失败零业务写", async () => {
    expect(
      HANDLERS.some((handler) => handler.route.operationId === "admin.sample.requestChange"),
    ).toBe(true);
    const body = { versionNo: 1, feedbackKind: "compose", note: "字幕上移", feedbackTimeMs: 1234 },
      before = await evidence();
    await fail(
      await post(`/admin/samples/${sampleId}/request-change`, body, denied),
      403,
      "PERMISSION_DENIED",
    );
    await fail(
      await post(`/admin/samples/${sampleId}/request-change`, body, outsider),
      404,
      "NOT_FOUND",
    );
    await fail(
      await post(`/admin/samples/${sampleId}/request-change`, { ...body, versionNo: 2 }),
      409,
      "SAMPLE_VERSION_STALE",
    );
    await fail(
      await post(`/admin/samples/${sampleId}/request-change`, {
        ...body,
        feedbackFileIds: [merchantScreenshotId],
      }),
      400,
      "FILE_NOT_USABLE",
    );
    await fail(
      await post(`/admin/samples/${sampleId}/request-change`, {
        ...body,
        feedbackKind: "ad_content",
      }),
      400,
      "VALIDATION_FAILED",
    );
    await fail(
      await post(`/admin/samples/${sampleId}/request-change`, {
        ...body,
        feedbackKind: "ad_content",
        adId: uuidv7(),
      }),
      409,
      "AD_CHANGED",
    );
    expect(await evidence()).toEqual(before);
  });
  it("在途真实取消暂停时拒绝反馈，撤回后仍沿原恢复机制", async () => {
    const ticket = await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
      quote = await data<{ expect: { totalRefundPoints: number } }>(
        await post(`/admin/orders/${ticket.dramaOrderId}/cancel-quote`, {
          reasonCode: "merchant_request",
        }),
      ),
      cancel = await data<{ cancelRequestId: string }>(
        await post(`/admin/orders/${ticket.dramaOrderId}/cancel-requests`, {
          reasonCode: "merchant_request",
          note: "反馈暂停守卫真实取消前置",
          expect: quote.expect,
        }),
      );
    const before = await evidence();
    await fail(
      await post(`/admin/samples/${sampleId}/request-change`, {
        versionNo: 1,
        feedbackKind: "compose",
        note: "暂停时不应写入",
      }),
      409,
      "TICKET_ON_HOLD",
    );
    expect(await evidence()).toEqual(before);
    await data(
      await post(`/admin/cancel-requests/${cancel.cancelRequestId}/withdraw`, {
        note: "结束暂停守卫验收",
      }),
    );
    expect(
      (await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } })).pauseCount,
    ).toBe(0);
  });
  it("compose沿同一writer退回制作并读回员工/时间点，原key重放无新反馈或积分", async () => {
    const ticketBefore = await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } });
    const key = uuidv7(),
      body = { versionNo: 1, feedbackKind: "compose", note: "字幕上移", feedbackTimeMs: 1234 };
    const response = await post(`/admin/samples/${sampleId}/request-change`, body, admin, key);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const view = AdminSampleViewSchema.parse(await data(response));
    expect(view).toMatchObject({
      sampleId,
      status: "change_requested",
      decision: {
        decideClient: "admin",
        feedbackKind: "compose",
        feedbackTimeMs: 1234,
        onBehalfBy: { staffId: admin.staff.id },
      },
    });
    expect(
      await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    ).toMatchObject({ step: "sample_making", sampleRoundNo: ticketBefore.sampleRoundNo + 1 });
    const before = await evidence();
    await data(await post(`/admin/samples/${sampleId}/request-change`, body, admin, key));
    expect(await evidence()).toEqual(before);
    await fail(
      await post(
        `/admin/samples/${sampleId}/request-change`,
        { ...body, note: "同key不同意见" },
        admin,
        key,
      ),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
  it("ad_content真实免费重开并取代其他浮动样片，原key重放不增加修改轮次", async () => {
    const f = await createW508OrderAdFixture(prisma, {
      databaseUrl: await h.db.url(),
      redisUrl: api.runtime.env.REDIS_URL,
      redisKeyPrefix: `${h.redis.prefix}w508feedback:`,
      clock: api.clock,
    });
    try {
      const ad = await f.createAd(),
        version = await f.pushAd(ad.adId);
      await f.confirmAd(ad.adId, version.versionNo);
      const own = await f.createBoundOrder(ad.adId),
        other = await f.createBoundOrder(ad.adId),
        source = await f.pushSample(own),
        peerSample = await f.pushSample(other),
        body = {
          versionNo: source.versionNo,
          feedbackKind: "ad_content",
          adId: ad.adId,
          note: "调整广告中的品牌用语",
          feedbackTimeMs: 6789,
        },
        key = uuidv7();
      const moneyBefore = await snapshotTables(prisma, [
        "billing_account",
        "point_hold",
        "ledger_operation",
        "point_ledger_entry",
      ]);
      const view = AdminSampleViewSchema.parse(
        await data(
          await post(`/admin/samples/${source.sampleId}/request-change`, body, admin, key),
        ),
      );
      expect(view).toMatchObject({
        status: "superseded",
        decision: {
          decideClient: "admin",
          feedbackKind: "ad_content",
          feedbackTimeMs: 6789,
          onBehalfBy: { staffId: admin.staff.id },
        },
      });
      expect(await prisma.ad.findUniqueOrThrow({ where: { id: ad.adId } })).toMatchObject({
        status: "revising",
        revisionCount: 1,
      });
      expect(await prisma.adRevision.findFirstOrThrow({ where: { adId: ad.adId } })).toMatchObject({
        source: "sample_feedback",
        onVersionNo: version.versionNo,
        actorType: "staff",
        actorId: admin.staff.id,
        client: "admin",
        isChargeable: false,
        chargePoints: 0,
      });
      for (const target of [own, other])
        expect(
          await prisma.deliveryTicket.findUniqueOrThrow({ where: { id: target.ticketId } }),
        ).toMatchObject({ step: "ad_prep" });
      expect(
        await prisma.sample.findUniqueOrThrow({ where: { id: peerSample.sampleId } }),
      ).toMatchObject({ status: "superseded" });
      expect(
        await snapshotTables(prisma, [
          "billing_account",
          "point_hold",
          "ledger_operation",
          "point_ledger_entry",
        ]),
      ).toEqual(moneyBefore);
      const before = await evidence();
      await data(await post(`/admin/samples/${source.sampleId}/request-change`, body, admin, key));
      expect(await evidence()).toEqual(before);
    } finally {
      await f.close();
    }
  });
});
