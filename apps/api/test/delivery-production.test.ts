// PR2 真 handler 与鉴权链；工单初始 sample_making 是上游 PR1/未来 W117 的显式夹具，媒体已知事实是 M3 替身。
import { beforeAll, it, expect } from "vitest";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import { audit, createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { HANDLERS } from "../src/routes/index.js";
const handle = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  stranger: SignedInMerchant,
  editor: SignedInStaff,
  qc: SignedInStaff,
  limited: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  ticket: string,
  item: string,
  store: string,
  entity: string,
  sample: string,
  first: string,
  second: string;
let peer = 0;
const routes = [
  ["admin.deliveryTicket.sample.create", "POST", "/admin/delivery-tickets/:ticket/samples"],
  ["admin.sample.inspect", "POST", "/admin/samples/:sample/inspect"],
  ["admin.sample.push", "POST", "/admin/samples/:sample/push"],
  ["m.orderItem.sample.get", "GET", "/m/order-items/:item/sample"],
  ["m.sample.confirm", "POST", "/m/samples/:sample/confirm"],
  [
    "admin.deliveryTicket.episodeOutput.list",
    "GET",
    "/admin/delivery-tickets/:ticket/episode-outputs",
  ],
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
] as const;
async function req(
  op: (typeof routes)[number][0],
  json?: unknown,
  headers?: Record<string, string>,
  key = uuidv7(),
) {
  const [, method, path] = routes.find((r) => r[0] === op)!;
  return api.request(
    `/api/v1${path.replace(":ticket", ticket).replace(":item", item).replace(":sample", sample)}`,
    {
      method,
      ...(json === undefined ? {} : { json }),
      headers: {
        ...(headers ?? (op.startsWith("admin.") ? qc.headers : owner.withStore(store))),
        "Idempotency-Key": key,
      },
      peer: `198.19.117.${++peer}`,
    },
  );
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}
async function privateData(response: Response) {
  const result = await data(response);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return result;
}
async function checks(code: string) {
  const t = await prisma.checklistTemplate.findFirstOrThrow({ where: { code, status: "active" } });
  return {
    checklistVersionNo: t.versionNo,
    results: ChecklistItemsSchema.parse(t.items).map((i) => ({
      key: i.key,
      result: "pass" as const,
    })),
  };
}
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  make = createFactories({ db: prisma, clock: api.clock });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  clerk = await signInAsMerchant(api);
  stranger = await signInAsMerchant(api);
  editor = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  qc = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  limited = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  const e = await make.entity({
      createdByUserId: owner.merchantUserId,
      verificationStatus: "verified",
    }),
    s = await make.store({ entityId: e.id, isPrimary: true, qualificationStatus: "verified" }),
    member = await make.entityMember({
      entityId: e.id,
      merchantUserId: owner.merchantUserId,
      role: "owner",
    }),
    cm = await make.entityMember({ entityId: e.id, merchantUserId: clerk.merchantUserId });
  entity = e.id;
  store = s.id;
  await make.storeMember({ entityMemberId: cm.id, storeId: store, addedByMemberId: member.id });
  const order = await make.dramaOrder({ entityId: entity, storeId: store, status: "producing" }),
    poster = await make.fileObject(),
    i = await make.orderItem({
      dramaOrderId: order.id,
      phase: "producing",
      episodeCount: 2,
      dramaSnapshot: { title: "虚构API验收剧", posterFileId: poster.id },
    });
  item = i.id;
  await prisma.drama.update({ where: { id: i.dramaId }, data: { synopsis: "虚构验收简介" } });
  const t = await make.deliveryTicket({ orderItemId: item, step: "sample_making" });
  ticket = t.id;
  await prisma.deliveryTicketStage.create({
    data: {
      id: uuidv7(),
      deliveryTicketId: ticket,
      step: "sample_making",
      updatedAt: api.clock.now(),
      visitNo: 1,
      enteredAt: api.clock.now(),
      createdAt: api.clock.now(),
    },
  });
  for (const category of ["sample_video", "final_episode"]) {
    const f = await make.fileObject({
      category,
      scopeType: "store",
      entityId: entity,
      storeId: store,
      bucket: "media",
      ext: "mp4",
      mime: "video/mp4",
      declaredMime: "video/mp4",
      uploadActorType: "staff",
      uploadActorId: editor.staff.id,
      uploadClient: "admin",
    });
    if (category === "sample_video") {
      first = f.id;
      await prisma.mediaInfo.create({
        data: {
          fileId: f.id,
          kind: "video",
          durationMs: 60000,
          width: 1080,
          height: 1920,
          probeVersion: 1,
          raw: { fixture: "explicit known video metadata; no production probe claim" },
          probedAt: api.clock.now(),
          createdAt: api.clock.now(),
          updatedAt: api.clock.now(),
        },
      });
    } else second = f.id;
  }
}, 180000);
it("十 API 真实状态/角色/范围/两读 no-store；包 guard 为真实缺账号而非默认 INTERNAL", async () => {
  for (const [op] of routes)
    expect(
      HANDLERS.some((h) => h.route.operationId === op),
      op,
    ).toBe(true);
  const createBody = { fileId: first, adSlots: [] },
    key = uuidv7(),
    created = await privateData(
      await req("admin.deliveryTicket.sample.create", createBody, editor.headers, key),
    );
  sample = created.sampleId as string;
  expect(created).toMatchObject({
    status: "uploaded",
    preview: { url: expect.any(String) },
    replayed: false,
  });
  expect(
    await privateData(
      await req("admin.deliveryTicket.sample.create", createBody, editor.headers, key),
    ),
  ).toMatchObject({ replayed: true, preview: null });
  expect(
    (await req("admin.sample.inspect", await checks("qc.sample"), editor.headers)).status,
  ).toBe(409);
  const qcBody = await checks("qc.sample"),
    qcKey = uuidv7(),
    pushKey = uuidv7();
  expect(
    await privateData(await req("admin.sample.inspect", qcBody, undefined, qcKey)),
  ).toMatchObject({
    status: "qc_passed",
    preview: { url: expect.any(String) },
  });
  expect(
    await privateData(await req("admin.sample.inspect", qcBody, undefined, qcKey)),
  ).toMatchObject({
    replayed: true,
    preview: null,
  });
  expect(await privateData(await req("admin.sample.push", {}, undefined, pushKey))).toMatchObject({
    status: "pushed",
    previewChannels: ["album", "portal"],
    preview: { url: expect.any(String) },
  });
  expect(await privateData(await req("admin.sample.push", {}, undefined, pushKey))).toMatchObject({
    replayed: true,
    preview: null,
  });
  for (const op of ["m.orderItem.sample.get", "admin.deliveryTicket.episodeOutput.list"] as const) {
    const r = await req(op);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    await data(r);
  }
  for (const [op, b] of [
    ["m.orderItem.sample.get", undefined],
    ["m.sample.confirm", { versionNo: 1, viewedVia: "album", hasViewed: true }],
  ] as const)
    expect((await req(op, b, clerk.withStore(store))).status).toBe(403);
  const foreign = await make.entity({
      createdByUserId: stranger.merchantUserId,
      verificationStatus: "verified",
    }),
    outside = await make.store({
      entityId: foreign.id,
      isPrimary: true,
      qualificationStatus: "verified",
    });
  await make.entityMember({
    entityId: foreign.id,
    merchantUserId: stranger.merchantUserId,
    role: "owner",
  });
  expect(
    (await req("m.orderItem.sample.get", undefined, stranger.withStore(outside.id))).status,
  ).toBe(404);
  expect(
    (await req("admin.deliveryTicket.episodeOutput.list", undefined, limited.headers)).status,
  ).toBe(404);
  expect(
    (await req("m.sample.confirm", { versionNo: 1, viewedVia: "album", hasViewed: true })).status,
  ).toBe(409);
  await api.runtime.tx.run((tx) =>
    audit.record(
      tx,
      createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp", role: "owner" },
      }).actor,
      { requestId: null, ip: null, userAgent: null, sessionId: null, authMethod: null },
      {
        stream: "access",
        category: "delivery",
        action: "delivery.sample.album_download",
        summary: "W116b 查看事实替身",
        target: { type: "sample", id: sample },
        entityId: entity,
        storeId: store,
      },
    ),
  );
  const confirmKey = uuidv7(),
    confirmBody = { versionNo: 1, viewedVia: "album", hasViewed: true };
  expect(
    await privateData(await req("m.sample.confirm", confirmBody, undefined, confirmKey)),
  ).toMatchObject({ status: "confirmed", ticketStep: "batch_compose" });
  expect(
    await privateData(await req("m.sample.confirm", confirmBody, undefined, confirmKey)),
  ).toMatchObject({ replayed: true, playable: null });
  const ep = await data(
      await req(
        "admin.deliveryTicket.episodeOutput.create",
        {
          items: [
            { episodeNo: 1, sampleId: sample },
            { episodeNo: 2, fileId: second },
          ],
        },
        editor.headers,
      ),
    ),
    items = ep.items as Array<{ episodeOutputId: string }>;
  const c = await checks("qc.episode");
  expect(
    await data(
      await req("admin.deliveryTicket.inspectEpisodes", {
        episodeOutputIds: items.map((e) => e.episodeOutputId),
        checklistVersionNo: c.checklistVersionNo,
        defaultResults: c.results,
      }),
    ),
  ).toMatchObject({ ticket: { step: "batch_compose" } });
  expect(
    await data(await req("admin.deliveryTicket.inspectPackage", await checks("qc.package"))),
  ).toMatchObject({ ticket: { step: "delivering" } });
  const blocked = await req("admin.deliveryTicket.pushPackage", {
    precheck: await checks("delivery.precheck"),
  });
  expect(blocked.status, await blocked.clone().text()).toBe(409);
  expect(await blocked.json()).toMatchObject({
    error: "PACKAGE_PUSH_BLOCKED",
    details: {
      blockers: expect.arrayContaining([
        { code: "account_unbound" },
        { code: "launch_date_missing" },
      ]),
    },
  });
  expect(await prisma.deliveryRelease.count({ where: { deliveryTicketId: ticket } })).toBe(0);
}, 120000);

it("C18 播放开启时首次确认含真实签名播放地址且 no-store，重放仍 no-store 与 C50 null", async () => {
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
  const o = await make.dramaOrder({ entityId: entity, storeId: store, status: "producing" }),
    i = await make.orderItem({
      dramaOrderId: o.id,
      phase: "producing",
      dramaSnapshot: { title: "虚构 C18 确认剧" },
    }),
    t = await make.deliveryTicket({ orderItemId: i.id, step: "sample_making" }),
    f = await make.fileObject({
      category: "sample_video",
      scopeType: "store",
      entityId: entity,
      storeId: store,
      bucket: "media",
      ext: "mp4",
      mime: "video/mp4",
      declaredMime: "video/mp4",
      uploadActorType: "staff",
      uploadActorId: editor.staff.id,
      uploadClient: "admin",
    });
  await prisma.deliveryTicketStage.create({
    data: {
      id: uuidv7(),
      deliveryTicketId: t.id,
      step: "sample_making",
      visitNo: 1,
      enteredAt: api.clock.now(),
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  await prisma.mediaInfo.create({
    data: {
      fileId: f.id,
      kind: "video",
      durationMs: 60000,
      width: 1080,
      height: 1920,
      probeVersion: 1,
      raw: { fixture: "explicit known video metadata for C18 confirmation" },
      probedAt: api.clock.now(),
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  ticket = t.id;
  item = i.id;
  sample = (
    await privateData(
      await req(
        "admin.deliveryTicket.sample.create",
        { fileId: f.id, adSlots: [] },
        editor.headers,
      ),
    )
  ).sampleId as string;
  await privateData(await req("admin.sample.inspect", await checks("qc.sample")));
  expect(await privateData(await req("admin.sample.push", {}))).toMatchObject({
    previewChannels: ["weapp"],
  });
  const key = uuidv7(),
    b = { versionNo: 1, viewedVia: "weapp", hasViewed: false },
    first = await privateData(await req("m.sample.confirm", b, undefined, key));
  expect(first).toMatchObject({
    status: "confirmed",
    replayed: false,
    playable: { sources: [{ url: expect.stringContaining("https://") }] },
  });
  const snapshot = [
    await prisma.statusTransition.count(),
    await prisma.auditLog.count(),
    await prisma.outboxEvent.count(),
  ];
  expect(await privateData(await req("m.sample.confirm", b, undefined, key))).toMatchObject({
    replayed: true,
    playable: null,
  });
  expect([
    await prisma.statusTransition.count(),
    await prisma.auditLog.count(),
    await prisma.outboxEvent.count(),
  ]).toEqual(snapshot);
  const cached = await prisma.idempotencyRecord.findFirstOrThrow({
    where: { scope: "m.sample.confirm", key },
  });
  expect(cached.result).toMatchObject({ playable: null });
  expect(JSON.stringify(cached.result)).not.toContain("https://");
}, 120000);
