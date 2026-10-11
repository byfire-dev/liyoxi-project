import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { createIdentityContext, createIdempotencyContext, uuidv7 } from "../../kernel/index.js";
import type { MediaActor } from "../index.js";
import {
  createMediaAssetsHarness,
  useSeededDatabase,
  configTestStaffBriefs,
} from "../../testing/index.js";
import { createConfig, createConfigAdmin } from "../../config/index.js";
import { AssetJobInputSchema } from "./pipeline.js";
import { createCalendarAdmin } from "../../sla/index.js";
import { ok } from "../../providers/types.js";
import type { DeliveredEvent, FiredTimer } from "../../kernel/index.js";

const db = useSeededDatabase("services");
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
beforeAll(async () => {
  h = await createMediaAssetsHarness(await db.prisma());
  const admin = createConfigAdmin({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    config: createConfig({ db: h.prisma, clock: h.clock, redis: null }),
    staffBriefs: configTestStaffBriefs,
  });
  for (const dimension of ["usage", "timeliness"] as const)
    await admin.createDictItem(
      { identity: h.admin.identity, staff: h.admin.staff! },
      { typeKey: "asset_tag", name: `测试${dimension}`, ext: { dimension } },
    );
}, 120_000);
afterAll(async () => {
  await h?.close();
});
const createText = (textBody = "门店新鲜制作与招牌口味") =>
  h.media.assets.create(h.owner, { type: "text", textBody });
async function processed() {
  const created = await createText();
  await h.drain(created.storeAssetId);
  return h.media.assets.get(h.admin, created.storeAssetId);
}
async function reviewBody(usability = "ready") {
  const rows = await h.prisma.dictItem.findMany({
    where: { dictTypeKey: "asset_tag", isEnabled: true },
  });
  const codes = (dimension: string) =>
    rows
      .filter((row) => (row.ext as { dimension?: string })?.dimension === dimension)
      .map((row) => row.code);
  return {
    contentTagCodes: codes("content").slice(0, 1),
    usageTagCodes: codes("usage").slice(0, 1),
    timeliness: { tagCode: codes("timeliness")[0]! },
    usability,
  };
}

it("实际登记→上传→complete/promote→素材引用，未配理解仍人工收尾且直记埋点不为 noop", async () => {
  const signing = vi.spyOn(h.fake.storage, "presignVisionGet").mockResolvedValue(
    ok({
      url: "https://public.invalid/unconfigured.jpg",
      expiresAt: new Date(h.clock.now().getTime() + 900_000),
    }),
  );
  onTestFinished(() => signing.mockRestore());
  const file = await h.stored();
  expect(file.status).toBe("stored");
  const view = await h.media.assets.create(h.owner, { type: "image", fileIds: [file.id] });
  expect(
    await h.prisma.fileRef.count({
      where: {
        fileId: file.id,
        refType: "store_asset",
        refId: view.storeAssetId,
        role: "main",
        releasedAt: null,
      },
    }),
  ).toBe(1);
  const finished = await h.drain(view.storeAssetId);
  expect(finished).toMatchObject({
    processingState: "processed",
    reviewState: "unreviewed",
    isInsightPartial: true,
  });
  expect(finished.title).toMatch(/^图片1项 \d{2}-\d{2} \d{2}:\d{2}$/u);
  expect(
    await h.prisma.storeAssetInsight.findMany({ where: { storeAssetId: finished.id } }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "vision",
        status: "skipped",
        content: { reason: "budget_unconfigured" },
      }),
    ]),
  );
  expect(h.fake.llm.calls).toHaveLength(0);
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: finished.id, eventType: "asset.processed" },
    }),
  ).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: finished.id, eventType: "asset.review_needed" },
    }),
  ).toBe(1);
  expect(
    await h.prisma.analyticsEvent.findFirstOrThrow({
      where: { eventId: `srv-${finished.id}-asset_upload` },
    }),
  ).toMatchObject({
    source: "direct",
    storeId: h.merchant.store.id,
    entityId: h.merchant.entity.id,
    props: { fileCount: 1, hasDemand: false, type: "image", uploaderRole: "owner" },
  });
});

it("非法分类、重复文件、跨店归属原子拒绝，素材/引用/埋点/审计均不残留", async () => {
  const own = await h.stored(),
    portrait = await h.stored(h.owner, "portrait_auth");
  const other = await h.make.merchant({ verified: true });
  const foreign: MediaActor = {
    identity: createIdentityContext({
      actor: { type: "merchant", id: other.user.id, client: "weapp", role: "owner" },
      entityId: other.entity.id,
      storeId: other.store.id,
    }),
    merchant: { entityId: other.entity.id, storeId: other.store.id, standing: "owner" },
  };
  const counts = async () =>
    Promise.all([
      h.prisma.storeAsset.count(),
      h.prisma.fileRef.count(),
      h.prisma.analyticsEvent.count(),
      h.prisma.auditLog.count(),
    ]);
  for (const [actor, fileIds] of [
    [h.owner, [own.id, own.id]],
    [h.owner, [portrait.id]],
    [foreign, [own.id]],
  ] as const) {
    const before = await counts();
    await expect(h.media.assets.create(actor, { type: "image", fileIds })).rejects.toMatchObject({
      error: "FILE_NOT_USABLE",
    });
    expect(await counts()).toEqual(before);
  }
});

it("重处理按真实任务收尾、旧 prompt 历史不丢失，旧 run 晚结果不能覆盖当前", async () => {
  const asset = await processed();
  const historical = await h.prisma.storeAssetInsight.create({
    data: {
      id: uuidv7(),
      storeAssetId: asset.storeAssetId,
      fileId: null,
      kind: "digest",
      promptVersion: 2,
      provider: "fake",
      status: "ok",
      content: { keypoints: ["历史模型版本"] },
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const oldJobs = await h.prisma.mediaJob.findMany({
    where: { parentType: "store_asset", parentId: asset.storeAssetId },
  });
  await h.media.assets.reprocess(h.admin, asset.storeAssetId, { kinds: ["digest"] });
  await h.drain(asset.storeAssetId);
  expect(
    await h.prisma.storeAssetInsight.findUniqueOrThrow({ where: { id: historical.id } }),
  ).toEqual(historical);
  for (const job of oldJobs) await h.media.jobs.run({ jobId: job.id });
  expect(
    await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: asset.storeAssetId } }),
  ).toMatchObject({ processingState: "processed" });
  expect(
    (
      await h.prisma.mediaJob.findMany({
        where: { parentType: "store_asset", parentId: asset.storeAssetId },
      })
    ).filter((job) => AssetJobInputSchema.safeParse(job.input).data?.runId !== asset.storeAssetId)
      .length,
  ).toBeGreaterThan(0);
});

it("同主体同实际指纹和 prompt 复用洞察，跨主体相同字节仍人工降级", async () => {
  // This case uploads the same eight PNG signature bytes three times. The fake
  // provider returns their fixed CRC64/ECMA-182 via HEAD, so complete/promote
  // persists actual non-null fingerprint metadata instead of editing FileObject.
  const head = h.fake.storage.head;
  const spy = vi.spyOn(h.fake.storage, "head").mockImplementation(async (input) => {
    const reply = await head(input);
    return reply.ok && reply.value.exists
      ? { ...reply, value: { ...reply.value, crc64: "7953934903724170396" } }
      : reply;
  });
  const previous = [...h.fake.llm.visionReplies];
  const content = {
    description: "同主体旧驱动已取得的洞察",
    quality: "公开虚构清晰画面",
    hasPeople: false,
    identifiableCustomerFace: false,
    textInImage: "",
  };
  const signing = vi.spyOn(h.fake.storage, "presignVisionGet").mockResolvedValue(
    ok({
      url: "https://public.invalid/vision.jpg",
      expiresAt: new Date(h.clock.now().getTime() + 900_000),
    }),
  );
  try {
    h.permitControlledModel(true);
    h.fake.llm.visionReplies.splice(0, h.fake.llm.visionReplies.length, content);
    const firstFile = await h.stored();
    expect(firstFile.crc64).not.toBeNull();
    const original = await h.media.assets.create(h.owner, {
      type: "image",
      fileIds: [firstFile.id],
    });
    await h.drain(original.storeAssetId);
    const insight = await h.prisma.storeAssetInsight.findFirstOrThrow({
      where: {
        storeAssetId: original.storeAssetId,
        fileId: firstFile.id,
        kind: "vision",
        promptVersion: 1,
      },
    });
    expect(insight).toMatchObject({ status: "ok", content, mediaJobId: expect.any(String) });
    h.permitControlledModel(false);
    h.fake.llm.resetCalls();
    signing.mockClear();
    const secondFile = await h.stored();
    expect(secondFile).toMatchObject({ crc64: firstFile.crc64, sizeBytes: firstFile.sizeBytes });
    const second = await h.media.assets.create(h.owner, {
      type: "image",
      fileIds: [secondFile.id],
    });
    await h.drain(second.storeAssetId);
    expect(
      await h.prisma.storeAssetInsight.findFirstOrThrow({
        where: { storeAssetId: second.storeAssetId, fileId: secondFile.id, kind: "vision" },
      }),
    ).toMatchObject({
      status: "ok",
      reusedFromStoreAssetInsightId: insight.id,
      content,
    });
    expect(signing).not.toHaveBeenCalled();
    const other = await h.make.merchant({ verified: true });
    const actor: MediaActor = {
      identity: createIdentityContext({
        actor: { type: "merchant", id: other.user.id, client: "weapp", role: "owner" },
        entityId: other.entity.id,
        storeId: other.store.id,
      }),
      merchant: { entityId: other.entity.id, storeId: other.store.id, standing: "owner" },
    };
    const thirdFile = await h.stored(actor);
    expect(thirdFile).toMatchObject({ crc64: firstFile.crc64, sizeBytes: firstFile.sizeBytes });
    const third = await h.media.assets.create(actor, { type: "image", fileIds: [thirdFile.id] });
    await h.drain(third.storeAssetId);
    expect(
      await h.prisma.storeAssetInsight.findFirstOrThrow({
        where: { storeAssetId: third.storeAssetId, fileId: thirdFile.id, kind: "vision" },
      }),
    ).toMatchObject({
      status: "skipped",
      reusedFromStoreAssetInsightId: null,
      content: { reason: "budget_unconfigured" },
    });
    expect(h.fake.llm.calls).toHaveLength(0);
    expect(signing).toHaveBeenCalledOnce();
  } finally {
    h.permitControlledModel(false);
    h.fake.llm.visionReplies.splice(0, h.fake.llm.visionReplies.length, ...previous);
    h.fake.llm.resetCalls();
    signing.mockRestore();
    spy.mockRestore();
  }
});

it("已领租约的理解 IO 在途删除父素材，晚结果取消且不写洞察或覆盖删除赢家", async () => {
  // Different real bytes prevent the prior same-fingerprint fixture from satisfying this step.
  const file = await h.stored(
    h.owner,
    "store_asset",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  );
  const card = await h.media.assets.create(h.owner, { type: "image", fileIds: [file.id] }),
    id = card.storeAssetId;
  let vision: Awaited<ReturnType<typeof h.prisma.mediaJob.findFirstOrThrow>> | null = null;
  for (let step = 0; step < 10 && !vision; step++) {
    vision = await h.prisma.mediaJob.findFirst({
      where: { parentType: "store_asset", parentId: id, kind: "vision", state: "queued" },
    });
    if (vision) break;
    const jobs = await h.prisma.mediaJob.findMany({
      where: {
        OR: [
          { parentType: "store_asset", parentId: id },
          { parentId: null, subjectType: "file_object", subjectId: file.id },
        ],
        state: { in: ["queued", "submitted"] },
        nextRunAt: { lte: h.clock.now() },
      },
    });
    for (const job of jobs) await h.media.jobs.run({ jobId: job.id });
    h.clock.advance(5_000);
  }
  expect(vision).not.toBeNull();
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actual = h.fake.llm.analyzeVision;
  const spy = vi.spyOn(h.fake.llm, "analyzeVision").mockImplementation(async (input) => {
    entered = true;
    await held;
    return actual(input);
  });
  const signing = vi.spyOn(h.fake.storage, "presignVisionGet").mockResolvedValue(
    ok({
      url: "https://public.invalid/vision.jpg",
      expiresAt: new Date(h.clock.now().getTime() + 900_000),
    }),
  );
  h.permitControlledModel(true);
  const running = h.media.jobs.run({ jobId: vision!.id });
  let winner!: Awaited<ReturnType<typeof h.prisma.storeAsset.findUniqueOrThrow>>;
  try {
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5_000 });
    expect(await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: vision!.id } })).toMatchObject({
      state: "running",
      attemptNo: 1,
      leaseOwner: expect.any(String),
    });
    await h.media.assets.remove(h.admin, id, { reasonText: "真实在途父撤销" });
    winner = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
  } finally {
    release();
    try {
      await running;
    } finally {
      spy.mockRestore();
      signing.mockRestore();
      h.permitControlledModel(false);
    }
  }
  expect(await h.prisma.mediaJob.findUniqueOrThrow({ where: { id: vision!.id } })).toMatchObject({
    state: "canceled",
    attemptNo: 1,
  });
  expect(winner).not.toBeNull();
  expect(await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } })).toEqual(winner);
  expect(
    await h.prisma.storeAssetInsight.count({ where: { storeAssetId: id, kind: "vision" } }),
  ).toBe(0);
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: id, eventType: { in: ["asset.processed", "asset.review_needed"] } },
    }),
  ).toBe(0);
});

it("同 key 双提交仅创建一份；双复核 CAS 一胜一冲突且事件与历史各一份", async () => {
  const key = uuidv7();
  const options = () => ({
    idem: createIdempotencyContext({
      mode: "required",
      actor: h.owner.identity.actor,
      scope: "m.storeAsset.create",
      key,
      request: {
        method: "POST",
        pathParams: {},
        body: { type: "text", textBody: "并发同键" },
        storeId: h.merchant.store.id,
      },
    }),
  });
  const creation = await Promise.allSettled([
    h.media.assets.create(h.owner, { type: "text", textBody: "并发同键" }, options()),
    h.media.assets.create(h.owner, { type: "text", textBody: "并发同键" }, options()),
  ]);
  expect(creation.filter((one) => one.status === "fulfilled")).toHaveLength(2);
  const values = creation.flatMap((one) => (one.status === "fulfilled" ? [one.value] : []));
  expect(new Set(values.map((one) => one.storeAssetId)).size).toBe(1);
  const id = values[0]!.storeAssetId;
  expect(
    await h.prisma.storeAsset.count({
      where: { storeId: h.merchant.store.id, idempotencyKey: key },
    }),
  ).toBe(1);
  await h.drain(id);
  const before = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
  const body = { ...(await reviewBody()), lockVersion: before.lockVersion };
  const results = await Promise.allSettled([
    h.media.assets.review(h.admin, id, body),
    h.media.assets.review(h.admin, id, body),
  ]);
  expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(1);
  expect(results.flatMap((one) => (one.status === "rejected" ? [one.reason] : []))).toEqual([
    expect.objectContaining({ error: "VERSION_CONFLICT" }),
  ]);
  expect(
    await h.prisma.outboxEvent.count({ where: { eventType: "asset.reviewed", aggregateId: id } }),
  ).toBe(1);
  expect(
    await h.prisma.auditLog.count({
      where: { targetType: "store_asset", targetId: id, action: "media.asset.review" },
    }),
  ).toBe(1);
});

it("肖像补交不等于确认，secure 材料仅员工可读；删除保留主文件7天与采用材料3年", async () => {
  const asset = await processed(),
    id = asset.storeAssetId;
  const initial = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
  await h.media.assets.review(h.admin, id, {
    ...(await reviewBody("need_portrait_auth")),
    lockVersion: initial.lockVersion,
  });
  const material = await h.stored(h.owner, "portrait_auth");
  await h.media.assets.portrait(h.owner, id, { fileIds: [material.id] });
  const waiting = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
  expect(waiting).toMatchObject({ usability: "need_portrait_auth", portraitAuthorizedAt: null });
  expect(await h.media.assets.get(h.owner, id)).toMatchObject({ portraitAuth: { fileCount: 1 } });
  await expect(
    h.media.signRead({ fileId: material.id, audience: "merchant" }),
  ).rejects.toMatchObject({ error: "FILE_NOT_USABLE" });
  await h.media.assets.confirmPortrait(h.admin, id, {
    lockVersion: waiting.lockVersion,
    usability: "ready",
  });
  await h.prisma.storeAssetUsage.create({
    data: {
      id: uuidv7(),
      storeAssetId: id,
      usedByType: "ad",
      usedById: uuidv7(),
      role: "adopted",
      createdAt: h.clock.now(),
    },
  });
  await h.prisma.storeAsset.update({ where: { id }, data: { adoptedCount: 1 } });
  const now = h.clock.now(),
    keep = new Date(now);
  keep.setUTCFullYear(keep.getUTCFullYear() + 3);
  await h.media.assets.remove(h.admin, id, { reasonText: "本轮素材撤回" });
  expect(
    await h.prisma.fileRef.findFirstOrThrow({
      where: { fileId: material.id, refType: "store_asset", refId: id },
    }),
  ).toMatchObject({ releasedAt: now, keepUntil: keep });
  await expect(h.media.assets.get(h.owner, id)).rejects.toMatchObject({ error: "NOT_FOUND" });
});

it("反馈同素材锁并发每日至多5条，超过拒绝且没有第6个审计或事件", async () => {
  const asset = await processed(),
    id = asset.storeAssetId;
  const originalClock = h.clock.now();
  const [databaseClock] = await h.prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  try {
    h.clock.set(databaseClock!.now);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        h.media.assets.feedback(h.owner, id, { content: "本轮反馈" }),
      ),
    );
    expect(results.filter((one) => one.status === "fulfilled")).toHaveLength(5);
    expect(results.flatMap((one) => (one.status === "rejected" ? [one.reason] : []))).toEqual([
      expect.objectContaining({ error: "ASSET_FEEDBACK_DAILY_LIMIT" }),
    ]);
    expect(
      await h.prisma.auditLog.count({ where: { targetId: id, action: "media.asset.feedback" } }),
    ).toBe(5);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: id, eventType: "asset.feedback_submitted" },
      }),
    ).toBe(5);
    const dates = await h.prisma.auditLog.findMany({
      where: { targetId: id, action: "media.asset.feedback" },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    console.warn("ASSET_FEEDBACK_CLOCK_ALIGNMENT", {
      clock: databaseClock!.now.toISOString(),
      count: dates.length,
      first: dates[0]!.createdAt.toISOString(),
      last: dates.at(-1)!.createdAt.toISOString(),
    });
    const beforeClock = h.clock.now();
    try {
      h.clock.advance(86_400_000);
      await expect(
        h.media.assets.feedback(h.owner, id, { content: "次日可反馈" }),
      ).resolves.toBeNull();
    } finally {
      h.clock.set(beforeClock);
    }
  } finally {
    h.clock.set(originalClock);
  }
});

it("需求真实创建/收到数/本人计数与范围；并发完成撤销只允许一个终态", async () => {
  const demand = await h.media.assets.demands.create(h.admin, {
    storeId: h.merchant.store.id,
    title: "请拍招牌菜",
    shootingNote: "横向拍摄",
    dueDate: h.clock.now().toISOString().slice(0, 10),
    notifyScope: "owner_and_clerks",
  });
  await h.media.assets.create(h.owner, {
    type: "text",
    textBody: "已提交描述",
    assetDemandId: demand.assetDemandId,
  });
  expect((await h.media.assets.demands.list(h.owner, {})).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        assetDemandId: demand.assetDemandId,
        receivedCount: 1,
        myUploadCount: 1,
      }),
    ]),
  );
  const outcomes = await Promise.allSettled([
    h.media.assets.demands.close(h.admin, demand.assetDemandId, "complete", {}),
    h.media.assets.demands.close(h.admin, demand.assetDemandId, "cancel", {
      reasonText: "本轮取消",
    }),
  ]);
  expect(outcomes.filter((one) => one.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.flatMap((one) => (one.status === "rejected" ? [one.reason] : []))).toEqual([
    expect.objectContaining({ error: "STATE_NOT_ALLOWED" }),
  ]);
  expect(
    await h.prisma.storeAssetDemand.findUniqueOrThrow({ where: { id: demand.assetDemandId } }),
  ).toMatchObject({ closedAt: h.clock.now() });
});

it("稳定游标不漏同毫秒素材，ids按请求顺序且静默跳过跨店/删除对象", async () => {
  const a = await createText("同毫秒 A"),
    b = await createText("同毫秒 B"),
    c = await createText("同毫秒 C");
  const first = await h.media.assets.list(h.owner, { q: "同毫秒", limit: "2" });
  expect(first.items).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  const next = await h.media.assets.list(h.owner, {
    q: "同毫秒",
    limit: "2",
    cursor: first.nextCursor!,
  });
  expect(new Set([...first.items, ...next.items].map((row) => row.storeAssetId))).toEqual(
    new Set([a.storeAssetId, b.storeAssetId, c.storeAssetId]),
  );
  const ids = await h.media.assets.list(h.owner, {
    ids: [a.storeAssetId, uuidv7(), c.storeAssetId].join(","),
  });
  expect(ids.items.map((row) => row.storeAssetId)).toEqual([a.storeAssetId, c.storeAssetId]);
  expect(ids.hasMore).toBe(false);
});

it("日历真实导入重算保留 computedAt，同批次重复消费仅保留一个当前 timer", async () => {
  const beforeClock = h.clock.now();
  try {
    h.clock.set(new Date("2028-01-03T01:00:00Z"));
    const calendar = createCalendarAdmin({ tx: h.tx, clock: h.clock, events: h.events });
    const actor = {
      identity: h.admin.identity,
      staff: { ...h.admin.staff!, stepUpAt: h.clock.now() },
    };
    await calendar.import(actor, { year: 2028, days: [], source: "本轮日历基线" });
    const card = await createText("日历重算素材"),
      id = card.storeAssetId;
    const before = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
    const result = await calendar.import(actor, {
      year: 2028,
      days: [{ date: "2028-01-04", kind: "holiday", note: "本轮假日" }],
      source: "本轮真实修订",
    });
    expect(result.changedDays).toContain("2028-01-04");
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "calendar.imported" },
      orderBy: { id: "desc" },
    });
    const delivery: DeliveredEvent = {
      id: event.id,
      type: event.eventType,
      payload: event.payload as Record<string, unknown>,
    };
    const subscriber = h.assembly.subscriber("media.onCalendarImported")!;
    await h.tx.run((tx) => subscriber.handle(tx, delivery));
    const updated = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
    expect(updated.dueAt!.getTime()).toBeGreaterThan(before.dueAt!.getTime());
    expect(updated.slaSnapshot).toMatchObject({
      computedAt: (before.slaSnapshot as { computedAt: string }).computedAt,
      calendarVersion: result.calendarVersion,
    });
    const currentTimer = await h.prisma.timer.findFirstOrThrow({
      where: { subjectType: "store_asset", subjectId: id, status: { not: "cancelled" } },
    });
    expect(currentTimer.fireAt).toEqual(updated.dueAt);
    await h.tx.run((tx) => subscriber.handle(tx, delivery));
    expect(
      await h.prisma.timer.findMany({
        where: { subjectType: "store_asset", subjectId: id, status: { not: "cancelled" } },
      }),
    ).toEqual([currentTimer]);
    expect(
      await h.prisma.auditLog.count({
        where: { targetId: id, action: "media.asset.calendar_recomputed" },
      }),
    ).toBe(1);
  } finally {
    h.clock.set(beforeClock);
  }
});

it("SLA 公开处理器到期前不发、到期重复只发一次，已复核晚 timer 无效", async () => {
  const beforeClock = h.clock.now();
  try {
    const card = await createText("到期边界素材"),
      id = card.storeAssetId;
    await h.drain(id);
    const asset = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
    const timer = await h.prisma.timer.findFirstOrThrow({
      where: { subjectType: "store_asset", subjectId: id, status: "scheduled" },
    });
    await h.prisma.timer.update({
      where: { id: timer.id },
      data: {
        status: "dispatched",
        leaseUntil: new Date(asset.dueAt!.getTime() + 300_000),
        dispatchNo: 1,
      },
    });
    const input: FiredTimer = {
      id: timer.id,
      kind: timer.kind,
      subjectType: timer.subjectType,
      subjectId: timer.subjectId,
      payload: timer.payload as Record<string, unknown>,
    };
    const handler = h.assembly.timerHandler("sla.breach")!;
    h.clock.set(new Date(asset.dueAt!.getTime() - 1));
    expect(await h.tx.run((tx) => handler.handle(tx, input))).toBe("skipped");
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "asset.sla_breached", aggregateId: id },
      }),
    ).toBe(0);
    h.clock.advance(1);
    expect(await h.tx.run((tx) => handler.handle(tx, input))).toBe("fired");
    expect(await h.tx.run((tx) => handler.handle(tx, input))).toBe("fired");
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "asset.sla_breached", aggregateId: id },
      }),
    ).toBe(1);
    const refreshed = { ...h.admin, staff: { ...h.admin.staff!, stepUpAt: h.clock.now() } };
    await h.media.assets.review(refreshed, id, {
      ...(await reviewBody()),
      lockVersion: asset.lockVersion,
    });
    expect(await h.tx.run((tx) => handler.handle(tx, input))).toBe("skipped");
    expect(
      await h.prisma.outboxEvent.count({
        where: { eventType: "asset.sla_breached", aggregateId: id },
      }),
    ).toBe(1);
  } finally {
    h.clock.set(beforeClock);
  }
});

it("实际 I11/I12/I16/I17 检查发现停滞、未授权采用、计数和标签维度污染", async () => {
  const card = await createText("不变量实际素材"),
    id = card.storeAssetId;
  await h.drain(id);
  const row = await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
  await h.media.assets.review(h.admin, id, {
    ...(await reviewBody("need_portrait_auth")),
    lockVersion: row.lockVersion,
  });
  await h.prisma.storeAssetUsage.create({
    data: {
      id: uuidv7(),
      storeAssetId: id,
      usedByType: "ad",
      usedById: uuidv7(),
      role: "adopted",
      createdAt: h.clock.now(),
    },
  });
  const content = (await reviewBody()).contentTagCodes[0]!;
  await h.prisma.storeAssetTag.create({
    data: {
      id: uuidv7(),
      storeAssetId: id,
      tagCode: content,
      dimension: "usage",
      source: "auto",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  for (const code of ["media.I12", "media.I16", "media.I17"]) {
    const run = h.assembly.invariants.find((item) => item.code === code)?.run;
    expect(run).toBeDefined();
    if (!run) throw new Error(`Missing invariant ${code}`);
    const found = await h.tx.run((tx) =>
      run(tx, { entityIds: [row.entityId] }, { now: h.clock.now() }),
    );
    expect(found.length).toBeGreaterThan(0);
  }
  await h.prisma.storeAsset.update({
    where: { id },
    data: {
      processingState: "processing",
      updatedAt: new Date(h.clock.now().getTime() - 16 * 60_000),
    },
  });
  const i11 = h.assembly.invariants.find((item) => item.code === "media.I11")?.run;
  expect(i11).toBeDefined();
  if (!i11) throw new Error("Missing invariant media.I11");
  const stalled = await h.tx.run((tx) =>
    i11(tx, { entityIds: [row.entityId] }, { now: h.clock.now() }),
  );
  expect(stalled).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ subject: { type: "store_asset", id }, healed: expect.anything() }),
    ]),
  );
  expect(await h.prisma.storeAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({
    processingState: "processed",
  });
});
