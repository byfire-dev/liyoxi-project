// W1-16b 四条登录签发/详情；上游用真实账号核验、方案、QC及推包，已知媒体事实为明确测试替身。
import { beforeAll, it, expect } from "vitest";
import {
  createFactories,
  signInAsStaff,
  createDeliveryProductionTools,
  finishDeliveryProductionForTest,
  prepareDeliveryMasterForTest,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import {
  createIdentityContext,
  createTickets,
  prepareTicketAssignees,
  createSla,
  runSeed,
  uuidv7,
} from "@liyoxi/services";
import {
  ChecklistItemsSchema,
  EpisodeDownloadUrlSchema,
  ReleaseViewSchema,
  DeliveryReleaseDetailSchema,
} from "@liyoxi/contract";
import { RATE_LIMIT_QUOTAS } from "../src/http/rate-limit-quotas.js";
import type { FakeStorage } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
const handle = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  stranger: SignedInMerchant,
  admin: SignedInStaff,
  limited: SignedInStaff,
  qc: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  storeId: string,
  entityId: string,
  planId: string,
  ticketId: string,
  itemId: string,
  accountId: string,
  sampleId: string,
  releaseId: string,
  firstFileId: string,
  finalFileId: string,
  peer = 0;
const routes = [
  ["m.sample.downloadUrls", "POST", "/m/samples/:sample/download-urls"],
  ["m.orderItem.release.get", "GET", "/m/order-items/:item/release"],
  ["m.orderItem.downloadUrls", "POST", "/m/order-items/:item/download-urls"],
  ["admin.deliveryRelease.get", "GET", "/admin/delivery-releases/:release"],
  ["admin.deliveryTicket.sample.create", "POST", "/admin/delivery-tickets/:ticket/samples"],
  ["admin.sample.inspect", "POST", "/admin/samples/:sample/inspect"],
  ["admin.sample.push", "POST", "/admin/samples/:sample/push"],
  ["m.sample.confirm", "POST", "/m/samples/:sample/confirm"],
  [
    "admin.deliveryTicket.episodeOutput.create",
    "POST",
    "/admin/delivery-tickets/:ticket/episode-outputs",
  ],
  [
    "admin.deliveryTicket.inspectEpisodes",
    "POST",
    "/admin/delivery-tickets/:ticket/inspect-episodes",
  ],
  [
    "admin.deliveryTicket.inspectPackage",
    "POST",
    "/admin/delivery-tickets/:ticket/inspect-package",
  ],
  ["admin.deliveryTicket.pushPackage", "POST", "/admin/delivery-tickets/:ticket/push-package"],
  ["admin.deliveryTicket.summary", "GET", "/admin/delivery-tickets/summary"],
  ["admin.deliveryTicket.get", "GET", "/admin/delivery-tickets/:ticket"],
  ["admin.deliveryTicket.assignManager", "POST", "/admin/delivery-tickets/:ticket/assign-manager"],
  ["admin.deliveryPlan.get", "GET", "/admin/delivery-plans/:plan"],
  ["admin.deliveryPlan.draft.replace", "PUT", "/admin/delivery-plans/:plan/draft"],
  ["admin.deliveryPlan.push", "POST", "/admin/delivery-plans/:plan/push"],
  ["m.deliveryPlan.get", "GET", "/m/delivery-plans/:plan"],
  ["m.deliveryPlan.confirm", "POST", "/m/delivery-plans/:plan/confirm"],
  ["m.deliveryPlan.requestChange", "POST", "/m/delivery-plans/:plan/request-change"],
] as const;
async function request(
  op: (typeof routes)[number][0],
  json?: unknown,
  headers?: Record<string, string>,
  key = uuidv7(),
) {
  const [, method, path] = routes.find((r) => r[0] === op)!;
  return api.request(
    `/api/v1${path.replace(":ticket", ticketId).replace(":plan", planId).replace(":sample", sampleId).replace(":item", itemId).replace(":release", releaseId)}`,
    {
      method,
      ...(json === undefined ? {} : { json }),
      headers: {
        ...(headers ?? (op.startsWith("admin.") ? admin.headers : owner.withStore(storeId))),
        "Idempotency-Key": key,
      },
      peer: `198.19.116.${++peer}`,
    },
  );
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}
beforeAll(async () => {
  api = await handle.start({
    mediaProduction: (providers) => {
      const external = createDeliveryProductionTools(providers);
      return { config: external.env, tools: external.tools };
    },
    rateLimitQuotas: {
      ...RATE_LIMIT_QUOTAS,
      "m.sign": [{ by: "user", limit: 8, windowSec: 3600 }],
    },
  });
  prisma = await handle.db.prisma();
  make = createFactories({ db: prisma, clock: api.clock });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  clerk = await signInAsMerchant(api);
  stranger = await signInAsMerchant(api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  qc = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  limited = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  const entity = await make.entity({
      createdByUserId: owner.merchantUserId,
      verificationStatus: "verified",
    }),
    store = await make.store({
      entityId: entity.id,
      isPrimary: true,
      qualificationStatus: "verified",
    }),
    member = await make.entityMember({
      entityId: entity.id,
      merchantUserId: owner.merchantUserId,
      role: "owner",
    });
  entityId = entity.id;
  storeId = store.id;
  const clerkMember = await make.entityMember({ entityId, merchantUserId: clerk.merchantUserId });
  await make.storeMember({ entityMemberId: clerkMember.id, storeId, addedByMemberId: member.id });
  const poster = await make.fileObject();
  const order = await make.dramaOrder({ entityId, storeId, status: "producing" }),
    item = await make.orderItem({
      dramaOrderId: order.id,
      phase: "producing",
      episodeCount: 2,
      dramaSnapshot: { title: "接口测试剧", posterFileId: poster.id },
    });
  itemId = item.id;
  await prisma.drama.update({
    where: { id: item.dramaId },
    data: { synopsis: "虚构下载接口验收简介" },
  });
  const r = api.runtime,
    created = await r.tx.run(async (tx) => {
      await prepareTicketAssignees(tx, order.id);
      return createTickets(
        tx,
        {
          tx: r.tx,
          clock: r.clock,
          assembly: r.assembly,
          flow: r.flow,
          events: r.events,
          sla: createSla({ clock: r.clock, assembly: r.assembly }),
        },
        createIdentityContext({
          actor: { type: "system", job: "lyxtest.api_seed" },
          entityId,
          storeId,
        }),
        { dramaOrderId: order.id },
      );
    });
  planId = created.deliveryPlanId;
  ticketId = created.deliveryTicketIds[0]!;
  await prisma.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "custom_focus",
      code: "CF01",
      name: "测试定制重点",
      isEnabled: true,
      position: 1,
      createdAt: r.clock.now(),
      updatedAt: r.clock.now(),
    },
  });
  // 账号事实走真实绑定与核验 API，避免把 available 伪装成无审批的夹具。
  const file = await make.fileObject({
    category: "channel_screenshot",
    bucket: "asset",
    scopeType: "store",
    entityId,
    storeId,
    uploadActorType: "merchant",
    uploadActorId: owner.merchantUserId,
    uploadClient: "weapp",
  });
  const bound = await data(
    await api.request("/api/v1/m/channel-accounts", {
      method: "POST",
      json: {
        platform: "douyin",
        accountName: "接口测试号",
        accountUid: uuidv7(),
        accountType: "none",
        screenshotFileIds: [file.id],
      },
      headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
      peer: `198.19.116.${++peer}`,
    }),
  );
  accountId = bound.channelAccountId as string;
  const sub = await prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: accountId },
      include: { approvalRequest: true },
    }),
    checklist = await prisma.checklistTemplate.findFirstOrThrow({
      where: { code: "account.verify", status: "active" },
    });
  const { COMPARE_FIELDS, ChecklistItemsSchema } = await import("@liyoxi/contract");
  await data(
    await api.request(`/api/v1/admin/channel-account-submissions/${sub.id}/approve`, {
      method: "POST",
      json: {
        lockVersion: sub.approvalRequest.lockVersion,
        confirm: {
          roundNo: sub.roundNo,
          accountUid: (await prisma.channelAccount.findUniqueOrThrow({ where: { id: accountId } }))
            .accountUid,
        },
        accountType: "none",
        certSubjectName: null,
        compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
        checklistVersionNo: checklist.versionNo,
        results: ChecklistItemsSchema.parse(checklist.items).map((i) => ({
          key: i.key,
          result: "pass",
        })),
      },
      headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
      peer: `198.19.116.${++peer}`,
    }),
  );
}, 180000);

async function checks(code: string) {
  const row = await prisma.checklistTemplate.findFirstOrThrow({
    where: { code, status: "active" },
  });
  return {
    checklistVersionNo: row.versionNo,
    results: ChecklistItemsSchema.parse(row.items).map((i) => ({
      key: i.key,
      result: "pass" as const,
    })),
  };
}
async function knownFile(category: "sample_video" | "final_episode", episodeNo: number) {
  const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: itemId } });
  await prepareDeliveryMasterForTest(api.runtime, prisma, {
    dramaId: item.dramaId,
    episodeNo,
    staffId: admin.staff.id,
  });
  const bytes = new Uint8Array(1234);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const registered = await data(
    await api.request("/api/v1/admin/files", {
      method: "POST",
      headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
      json: {
        category,
        storeId,
        production: {
          kind: category === "sample_video" ? "sample" : "final",
          orderItemId: itemId,
          episodeNo,
          aiUsage: { used: false, tools: [] },
        },
        fileName: `fiction-${episodeNo}.mp4`,
        sizeBytes: String(bytes.length),
        clientToken: uuidv7(),
      },
    }),
  );
  const entry = registered as { fileId: string; key: string };
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "media", key: entry.key },
    bytes,
    "video/mp4",
  );
  await data(
    await api.request(`/api/v1/admin/files/${entry.fileId}/complete`, {
      method: "POST",
      json: {},
      headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
    }),
  );
  const job = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${entry.fileId}` },
  });
  await api.runtime.media.promote({ jobId: job.id });
  await finishDeliveryProductionForTest(
    api.runtime,
    api.clock,
    entry.fileId,
    category === "sample_video",
  );
  return entry.fileId;
}
const writes = () =>
  Promise.all([
    prisma.auditLog.count(),
    prisma.statusTransition.count(),
    prisma.outboxEvent.count(),
    prisma.deliveryDownloadLog.count(),
  ]);
const own = () => owner.withStore(storeId);
const signed = async (response: Response) => {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return data(response);
};
it("四条实际登录HTTP链：Q9相册零签拒绝、勾选确认、成片900秒附件留痕、GET零写与publish范围", async () => {
  for (const op of [
    "m.sample.downloadUrls",
    "m.orderItem.release.get",
    "m.orderItem.downloadUrls",
    "admin.deliveryRelease.get",
  ])
    expect(
      HANDLERS.some((h) => h.route.operationId === op),
      op,
    ).toBe(true);
  const manager = await make.staff({ staffRoleKey: "delivery_manager" });
  await data(await request("admin.deliveryTicket.assignManager", { staffId: manager.id }));
  await data(
    await request("admin.deliveryPlan.draft.replace", {
      draftLockVersion: 0,
      content: {
        focusCodes: ["CF01"],
        referenceAssetIds: [],
        launchMode: "merchant_self",
        items: [
          {
            orderItemId: itemId,
            channelAccountIds: [accountId],
            placements: [],
            agreedLaunchDate: "2026-01-20",
          },
        ],
      },
    }),
  );
  await data(await request("admin.deliveryPlan.push", { draftLockVersion: 1 }));
  await data(await request("m.deliveryPlan.confirm", { versionNo: 1 }));
  firstFileId = await knownFile("sample_video", 1);
  sampleId = (
    await data(
      await request("admin.deliveryTicket.sample.create", { fileId: firstFileId, adSlots: [] }),
    )
  ).sampleId as string;
  await data(await request("admin.sample.inspect", await checks("qc.sample"), qc.headers));
  await data(await request("admin.sample.push", {}, qc.headers));
  expect(
    (await request("m.sample.confirm", { versionNo: 1, viewedVia: "album", hasViewed: true }))
      .status,
  ).toBe(409);
  const sampleKey = uuidv7(),
    before = await writes();
  const signCalls = (api.runtime.providers.storage as FakeStorage).callsOf("presignGet").length;
  for (let i = 0; i < 2; i++) {
    const denied = await request("m.sample.downloadUrls", {}, own(), sampleKey);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "FEATURE_DISABLED" });
    api.clock.advance(1000);
  }
  expect(
    (await prisma.sample.findUniqueOrThrow({ where: { id: sampleId } })).firstViewedAt,
  ).toBeNull();
  expect(
    await prisma.auditLog.count({
      where: {
        action: "delivery.sample.album_download",
        targetId: sampleId,
      },
    }),
  ).toBe(0);
  expect(await writes()).toEqual(before);
  expect((api.runtime.providers.storage as FakeStorage).callsOf("presignGet")).toHaveLength(
    signCalls,
  );
  const unchecked = await request("m.sample.confirm", {
    versionNo: 1,
    viewedVia: "weapp",
    hasViewed: false,
  });
  expect(await unchecked.json()).toMatchObject({ error: "VALIDATION_FAILED" });
  expect(await writes()).toEqual(before);
  await data(
    await request("m.sample.confirm", {
      versionNo: 1,
      viewedVia: "weapp",
      hasViewed: true,
    }),
  );
  finalFileId = await knownFile("final_episode", 2);
  const outputs = await data(
    await request("admin.deliveryTicket.episodeOutput.create", {
      items: [
        { episodeNo: 1, sampleId },
        { episodeNo: 2, fileId: finalFileId },
      ],
    }),
  );
  const e = await checks("qc.episode");
  await data(
    await request(
      "admin.deliveryTicket.inspectEpisodes",
      {
        episodeOutputIds: (outputs.items as Array<{ episodeOutputId: string }>).map(
          (i) => i.episodeOutputId,
        ),
        checklistVersionNo: e.checklistVersionNo,
        defaultResults: e.results,
      },
      qc.headers,
    ),
  );
  await data(
    await request("admin.deliveryTicket.inspectPackage", await checks("qc.package"), qc.headers),
  );
  const pushed = await data(
    await request(
      "admin.deliveryTicket.pushPackage",
      { precheck: await checks("delivery.precheck") },
      qc.headers,
    ),
  );
  releaseId = (pushed.release as { deliveryReleaseId: string }).deliveryReleaseId;
  const zero = await writes();
  const releaseResponse = await request("m.orderItem.release.get"),
    release = ReleaseViewSchema.parse(await data(releaseResponse));
  expect(releaseResponse.headers.get("Cache-Control")).toBe("no-store");
  expect(release).toMatchObject({
    isDownloadable: true,
    savedEpisodeCount: 0,
    canRegenerate: true,
  });
  const detail = DeliveryReleaseDetailSchema.parse(
    await data(await request("admin.deliveryRelease.get")),
  );
  expect(detail).toMatchObject({
    activeGrant: { downloadGrantId: release.grant!.downloadGrantId },
    actions: [],
  });
  expect(detail.manifest).toHaveLength(2);
  expect(await writes()).toEqual(zero);
  expect((await request("admin.deliveryRelease.get", undefined, limited.headers)).status).toBe(404);
  const key = uuidv7();
  const one = EpisodeDownloadUrlSchema.parse(
      await signed(
        await request("m.orderItem.downloadUrls", { kind: "episode", episodeNo: 1 }, own(), key),
      ),
    ),
    two = EpisodeDownloadUrlSchema.parse(
      await signed(
        await request("m.orderItem.downloadUrls", { kind: "episode", episodeNo: 1 }, own(), key),
      ),
    );
  expect(one.downloadId).not.toBe(two.downloadId);
  expect(one.fileName).toBe(release.episodes[0]!.fileName);
  expect(await prisma.deliveryDownloadLog.count({ where: { deliveryReleaseId: releaseId } })).toBe(
    2,
  );
  expect((await writes()).slice(0, 3)).toEqual(zero.slice(0, 3));
  expect(
    (api.runtime.providers.storage as FakeStorage).callsOf("presignGet").slice(-1)[0]!.input,
  ).toMatchObject({ expiresSec: 900, downloadName: one.fileName });
}, 120000);
it("三商家入口clerk403、跨主体与同主体外门店404、匿名401；样片归档拒绝而成片允许", async () => {
  const other = await make.entity({
      createdByUserId: stranger.merchantUserId,
      verificationStatus: "verified",
    }),
    otherStore = await make.store({
      entityId: other.id,
      isPrimary: true,
      qualificationStatus: "verified",
    }),
    sameEntityStore = await make.store({ entityId, qualificationStatus: "verified" });
  await make.entityMember({
    entityId: other.id,
    merchantUserId: stranger.merchantUserId,
    role: "owner",
  });
  for (const [op, body] of [
    ["m.sample.downloadUrls", {}],
    ["m.orderItem.release.get", undefined],
    ["m.orderItem.downloadUrls", { kind: "episode", episodeNo: 1 }],
  ] as const) {
    expect((await request(op, body, clerk.withStore(storeId))).status).toBe(403);
    expect((await request(op, body, stranger.withStore(otherStore.id))).status).toBe(404);
    expect((await request(op, body, owner.withStore(sameEntityStore.id))).status).toBe(404);
    expect((await request(op, body, {})).status).toBe(401);
  }
  await prisma.store.update({
    where: { id: storeId },
    data: {
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: api.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: owner.merchantUserId,
      archiveClient: "weapp",
    },
  });
  const archived = await request("m.sample.downloadUrls", {});
  expect(archived.status).toBe(403);
  expect(await archived.json()).toMatchObject({ error: "STORE_ARCHIVED" });
  await signed(await request("m.orderItem.downloadUrls", { kind: "episode", episodeNo: 2 }));
  await prisma.store.update({
    where: { id: storeId },
    data: {
      lifecycle: "active",
      archiveReason: null,
      archivedAt: null,
      archiveActorType: null,
      archiveActorId: null,
      archiveClient: null,
    },
  });
}, 60000);
it("m.sign共享档位600/小时；小额度真实429发生在业务写前", async () => {
  expect(RATE_LIMIT_QUOTAS["m.sign"]).toEqual([{ by: "user", limit: 600, windowSec: 3600 }]);
  let response: Response;
  for (let i = 0; i < 9; i++) {
    response = await request("m.orderItem.downloadUrls", { kind: "episode", episodeNo: 1 });
    if (response.status === 429) {
      const before = await writes();
      const again = await request("m.orderItem.downloadUrls", { kind: "episode", episodeNo: 1 });
      expect(again.status).toBe(429);
      expect(await again.json()).toMatchObject({ error: "RATE_LIMITED" });
      expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(await writes()).toEqual(before);
      return;
    }
    await data(response);
  }
  throw new Error("m.sign未返回429");
}, 60000);
