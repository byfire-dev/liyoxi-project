import { beforeAll, describe, expect, it, vi } from "vitest";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, prepareOrderFixture, signInAsStaff } from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import type {
  AdminStoreAssetDetail,
  AdminStoreAssetRow,
  FileRegistration,
  StoreAssetCard,
  StoreAssetDetail,
} from "@liyoxi/contract";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const handle = useTestApi();
let api: TestApi, owner: SignedInMerchant, clerk: SignedInMerchant, outsider: SignedInMerchant;
let admin: SignedInStaff,
  manager: SignedInStaff,
  otherManager: SignedInStaff,
  editor: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>, storage: FakeStorage;
let scope: { entityId: string; storeId: string; memberId: string },
  outsiderStoreId: string,
  peer = 0;
const operations = [
  "m.assetDemand.list",
  "m.storeAsset.create",
  "m.storeAsset.feedback.create",
  "m.storeAsset.get",
  "m.storeAsset.list",
  "m.storeAsset.portraitAuth.create",
  "m.storeAsset.summary",
  "admin.assetDemand.cancel",
  "admin.assetDemand.complete",
  "admin.assetDemand.create",
  "admin.assetDemand.list",
  "admin.storeAsset.confirmPortraitAuth",
  "admin.storeAsset.create",
  "admin.storeAsset.delete",
  "admin.storeAsset.get",
  "admin.storeAsset.list",
  "admin.storeAsset.portraitAuth.create",
  "admin.storeAsset.reprocess",
  "admin.storeAsset.review",
  "admin.storeAsset.summary",
] as const;
type Operation = (typeof operations)[number];
const passed = new Set<Operation>(),
  denied = new Set<Operation>();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function request(
  op: Operation,
  options: {
    id?: string;
    query?: string;
    body?: unknown;
    headers?: Record<string, string>;
    key?: string;
  } = {},
) {
  const route = HANDLERS.find((handler) => handler.route.operationId === op)!.route;
  const path = route.path.replace(/\{(?:storeAssetId|assetDemandId)\}/u, options.id ?? uuidv7());
  return api.request(`/api/v1${path}${options.query ? `?${options.query}` : ""}`, {
    method: route.method.toUpperCase(),
    ...(options.body === undefined || route.method === "get" ? {} : { json: options.body }),
    headers: {
      ...(options.headers ??
        (op.startsWith("admin.") ? admin.headers : owner.withStore(scope.storeId))),
      "Idempotency-Key": options.key ?? uuidv7(),
    },
    peer: `198.19.214.${++peer % 250}`,
  });
}
async function data<T>(response: Response, op?: Operation): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  if (op) {
    passed.add(op);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  return ((await response.json()) as { data: T }).data;
}
async function reject(response: Response, status: number, symbol?: string, op?: Operation) {
  expect(response.status, await response.clone().text()).toBe(status);
  if (symbol) expect(await response.json()).toMatchObject({ error: symbol });
  if (op) denied.add(op);
}
async function stored(
  who: SignedInMerchant | SignedInStaff,
  category: "store_asset" | "portrait_auth",
) {
  const staff = "staff" in who,
    headers = staff ? who.headers : who.withStore(scope.storeId);
  const registered = await api.request(`/api/v1/${staff ? "admin" : "m"}/files`, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": uuidv7() },
    json: staff
      ? {
          category,
          storeId: scope.storeId,
          onBehalfStore: true,
          fileName: "asset.png",
          sizeBytes: "8",
          clientToken: uuidv7(),
        }
      : { category, files: [{ fileName: "asset.png", sizeBytes: "8", clientToken: uuidv7() }] },
    peer: `198.19.213.${++peer % 250}`,
  });
  const file = staff
    ? await data<FileRegistration>(registered)
    : (await data<{ items: FileRegistration[] }>(registered)).items[0]!;
  const row = await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } });
  storage.put({ bucket: row.bucket as "asset" | "secure", key: file.key }, png, "image/png");
  await data(
    await api.request(`/api/v1/${staff ? "admin" : "m"}/files/${file.fileId}/complete`, {
      method: "POST",
      json: {},
      headers: { ...headers, "Idempotency-Key": uuidv7() },
      peer: `198.19.213.${++peer % 250}`,
    }),
  );
  const job = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.fileId}` },
  });
  await api.runtime.media.promote({ jobId: job.id });
  expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId } })).toMatchObject({
    status: "stored",
  });
  return file.fileId;
}
async function drain(id: string) {
  for (let step = 0; step < 8; step++) {
    const jobs = await prisma.mediaJob.findMany({
      where: {
        parentType: "store_asset",
        parentId: id,
        state: { in: ["queued", "submitted"] },
        nextRunAt: { lte: api.clock.now() },
      },
      orderBy: { id: "asc" },
    });
    for (const job of jobs) await api.runtime.media.jobs.run({ jobId: job.id });
    if (
      (await prisma.storeAsset.findUniqueOrThrow({ where: { id } })).processingState === "processed"
    )
      return;
    expect(jobs.length, "text asset must have a real due understanding step").toBeGreaterThan(0);
    api.clock.advance(5_000);
  }
  throw new Error("text asset exceeded bounded real job steps");
}
async function createText(textBody = "门店真实素材说明", extra: Record<string, unknown> = {}) {
  return data<StoreAssetCard>(
    await request("m.storeAsset.create", { body: { type: "text", textBody, ...extra } }),
    "m.storeAsset.create",
  );
}
async function review(id: string, usability = "ready") {
  const asset = await prisma.storeAsset.findUniqueOrThrow({ where: { id } });
  const tags = await prisma.dictItem.findMany({
    where: { dictTypeKey: "asset_tag", isEnabled: true },
  });
  const code = (dimension: string) =>
    tags.find((tag) => (tag.ext as { dimension?: string })?.dimension === dimension)!.code;
  return data<AdminStoreAssetDetail>(
    await request("admin.storeAsset.review", {
      id,
      body: {
        lockVersion: asset.lockVersion,
        contentTagCodes: [code("content")],
        usageTagCodes: [code("usage")],
        timeliness: { tagCode: code("timeliness") },
        usability,
      },
    }),
    "admin.storeAsset.review",
  );
}
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const make = createFactories({ db: prisma, clock: api.clock });
  clerk = await signInAsMerchant(api);
  const member = await make.entityMember({
    entityId: scope.entityId,
    merchantUserId: clerk.merchantUserId,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: scope.storeId,
    addedByMemberId: scope.memberId,
  });
  outsider = await signInAsMerchant(api);
  outsiderStoreId = (
    await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: outsider.merchantUserId, client: "weapp" },
      }),
    )
  ).storeId;
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  manager = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  otherManager = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  editor = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  await prisma.store.update({
    where: { id: scope.storeId },
    data: { deliveryManagerId: manager.staff.id },
  });
  storage = api.runtime.providers.storage as FakeStorage;
}, 180_000);

describe("素材20接口的实际鉴权、人工降级和引用", { timeout: 90_000 }, () => {
  it("20个原标识均挂载；guest全部401，后台无模块权限不能绕过领域权限", async () => {
    for (const op of operations) {
      expect(HANDLERS.filter((handler) => handler.route.operationId === op)).toHaveLength(1);
      await reject(
        await request(op, {
          headers: {},
          body:
            op.endsWith("list") || op.endsWith("get") || op.endsWith("summary") ? undefined : {},
        }),
        401,
        undefined,
        op,
      );
      if (op.startsWith("admin."))
        await reject(await request(op, { headers: editor.headers, body: {} }), 403);
    }
  });

  it("需求四后台接口与商家列表真实运行，老板/店员通知范围与关闭幂等保持", async () => {
    const input = {
      storeId: scope.storeId,
      title: "请拍招牌",
      shootingNote: "请保持画面明亮",
      dueDate: api.clock.now().toISOString().slice(0, 10),
      notifyScope: "owner_only",
    };
    const own = await data<{ assetDemandId: string }>(
      await request("admin.assetDemand.create", { body: input }),
      "admin.assetDemand.create",
    );
    const both = await data<{ assetDemandId: string }>(
      await request("admin.assetDemand.create", {
        body: { ...input, title: "请补充说明", notifyScope: "owner_and_clerks" },
      }),
      "admin.assetDemand.create",
    );
    expect(
      (
        await data<{ items: { assetDemandId: string }[] }>(
          await request("m.assetDemand.list"),
          "m.assetDemand.list",
        )
      ).items.map((row) => row.assetDemandId),
    ).toEqual(expect.arrayContaining([own.assetDemandId, both.assetDemandId]));
    expect(
      (
        await data<{ items: { assetDemandId: string }[] }>(
          await request("m.assetDemand.list", { headers: clerk.withStore(scope.storeId) }),
        )
      ).items.map((row) => row.assetDemandId),
    ).toEqual([both.assetDemandId]);
    await createText("需求的实际提交", { assetDemandId: both.assetDemandId });
    const listed = await data<{ items: { assetDemandId: string; receivedCount: number }[] }>(
      await request("admin.assetDemand.list", { query: `storeId=${scope.storeId}` }),
      "admin.assetDemand.list",
    );
    expect(
      listed.items.find((row) => row.assetDemandId === both.assetDemandId)?.receivedCount,
    ).toBe(1);
    const completeKey = uuidv7();
    expect(
      await data(
        await request("admin.assetDemand.complete", {
          id: both.assetDemandId,
          body: {},
          key: completeKey,
        }),
        "admin.assetDemand.complete",
      ),
    ).toMatchObject({ status: "done", closedAt: api.clock.now().toISOString() });
    expect(
      (
        await request("admin.assetDemand.complete", {
          id: both.assetDemandId,
          body: {},
          key: completeKey,
        })
      ).headers.get("Idempotent-Replayed"),
    ).toBe("true");
    await reject(
      await request("admin.assetDemand.complete", { id: both.assetDemandId, body: {} }),
      409,
      "STATE_NOT_ALLOWED",
    );
    expect(
      await data(
        await request("admin.assetDemand.cancel", {
          id: own.assetDemandId,
          body: { reasonText: "本轮取消" },
        }),
        "admin.assetDemand.cancel",
      ),
    ).toMatchObject({ status: "canceled" });
    await reject(
      await request("admin.assetDemand.list", {
        query: `storeId=${scope.storeId}`,
        headers: otherManager.headers,
      }),
      404,
      "NOT_FOUND",
    );
  });

  it("真实stored图创建首次签名、重放null不签且缓存无URL；get/list/summary零写与跨范围404", async () => {
    const fileId = await stored(owner, "store_asset"),
      key = uuidv7(),
      body = { type: "image", fileIds: [fileId] };
    const first = await data<StoreAssetCard>(
      await request("m.storeAsset.create", { body, key }),
      "m.storeAsset.create",
    );
    expect(first.thumbnail?.url).toEqual(expect.any(String));
    const calls = storage.callsOf("presignGet").length;
    const replayResponse = await request("m.storeAsset.create", { body, key });
    expect(replayResponse.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await data<StoreAssetCard>(replayResponse)).toMatchObject({
      storeAssetId: first.storeAssetId,
      thumbnail: null,
      replayed: true,
    });
    expect(storage.callsOf("presignGet")).toHaveLength(calls);
    const saved = await prisma.idempotencyRecord.findFirstOrThrow({
      where: { scope: "m.storeAsset.create", key },
    });
    expect(saved.result).toMatchObject({ thumbnail: null });
    expect(JSON.stringify(saved.result)).not.toContain(first.thumbnail!.url);
    const counts = async () =>
      Promise.all([
        prisma.storeAsset.count(),
        prisma.auditLog.count(),
        prisma.outboxEvent.count(),
        prisma.storeAssetUsage.count(),
      ]);
    const before = await counts();
    expect(
      await data<StoreAssetDetail>(
        await request("m.storeAsset.get", {
          id: first.storeAssetId,
          headers: clerk.withStore(scope.storeId),
        }),
        "m.storeAsset.get",
      ),
    ).toMatchObject({
      storeAssetId: first.storeAssetId,
      files: [expect.objectContaining({ fileId })],
    });
    expect(
      (
        await data<{ items: StoreAssetCard[] }>(
          await request("m.storeAsset.list", { query: `ids=${first.storeAssetId}` }),
          "m.storeAsset.list",
        )
      ).items,
    ).toHaveLength(1);
    expect(await data(await request("m.storeAsset.summary"), "m.storeAsset.summary")).toMatchObject(
      { tabs: { image: 1 }, organizingCount: expect.any(Number) },
    );
    expect(
      await data(
        await request("admin.storeAsset.get", { id: first.storeAssetId, headers: manager.headers }),
        "admin.storeAsset.get",
      ),
    ).toMatchObject({ storeAssetId: first.storeAssetId });
    await data(
      await request("admin.storeAsset.list", {
        query: `storeId=${scope.storeId}`,
        headers: manager.headers,
      }),
      "admin.storeAsset.list",
    );
    await data(
      await request("admin.storeAsset.summary", { query: `storeId=${scope.storeId}` }),
      "admin.storeAsset.summary",
    );
    expect(await counts()).toEqual(before);
    await reject(
      await request("admin.storeAsset.get", {
        id: first.storeAssetId,
        headers: otherManager.headers,
      }),
      404,
      "NOT_FOUND",
    );
    await reject(
      await request("m.storeAsset.get", {
        id: first.storeAssetId,
        headers: outsider.withStore(scope.storeId),
      }),
      403,
      "NOT_A_MEMBER",
    );
    await reject(
      await request("m.storeAsset.get", {
        id: first.storeAssetId,
        headers: outsider.withStore(outsiderStoreId),
      }),
      404,
      "NOT_FOUND",
    );
  });

  it("签名在途父素材被拦截，C18复核拒绝响应且不泄漏已生成URL", async () => {
    const fileId = await stored(owner, "store_asset");
    const asset = await data<StoreAssetCard>(
      await request("m.storeAsset.create", { body: { type: "image", fileIds: [fileId] } }),
    );
    const before = await prisma.storeAsset.findUniqueOrThrow({ where: { id: asset.storeAssetId } });
    const original = storage.presignGet.bind(storage);
    const spy = vi.spyOn(storage, "presignGet").mockImplementation(async (input) => {
      const signed = await original(input);
      await prisma.storeAsset.update({
        where: { id: asset.storeAssetId },
        data: { moderationState: "block" },
      });
      return signed;
    });
    try {
      const response = await request("m.storeAsset.get", { id: asset.storeAssetId });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await reject(response, 409, "FILE_NOT_AVAILABLE");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await prisma.storeAsset.update({
        where: { id: asset.storeAssetId },
        data: { moderationState: before.moderationState },
      });
    }
  });

  it("两分类真实上传按店员审核门控和员工本店范围；secure肖像签发留access审计", async () => {
    const post = (
      staff: boolean,
      category: string,
      headers: Record<string, string>,
      storeId = scope.storeId,
      onBehalfStore = true,
    ) =>
      api.request(`/api/v1/${staff ? "admin" : "m"}/files`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": uuidv7() },
        json: staff
          ? {
              category,
              storeId,
              onBehalfStore,
              fileName: "asset.png",
              sizeBytes: "8",
              clientToken: uuidv7(),
            }
          : { category, files: [{ fileName: "asset.png", sizeBytes: "8", clientToken: uuidv7() }] },
        peer: `198.19.212.${++peer % 250}`,
      });
    for (const category of ["store_asset", "portrait_auth"]) {
      await data(await post(false, category, clerk.withStore(scope.storeId)));
      const before = await prisma.fileObject.count();
      await reject(await post(true, category, editor.headers), 403, "PERMISSION_DENIED");
      await reject(await post(true, category, otherManager.headers), 404, "NOT_FOUND");
      await reject(
        await post(true, category, admin.headers, scope.storeId, false),
        400,
        "FILE_CATEGORY_NOT_ALLOWED",
      );
      expect(await prisma.fileObject.count()).toBe(before);
    }
    const make = createFactories({ db: prisma, clock: api.clock });
    const pending = await make.store({ entityId: scope.entityId });
    const member = await prisma.entityMember.findFirstOrThrow({
      where: { entityId: scope.entityId, merchantUserId: clerk.merchantUserId },
    });
    await make.storeMember({
      storeId: pending.id,
      entityMemberId: member.id,
      addedByMemberId: scope.memberId,
    });
    await reject(
      await post(false, "store_asset", clerk.withStore(pending.id)),
      409,
      "ASSET_UPLOAD_GATED",
    );
    const material = await stored(owner, "portrait_auth");
    const accesses = await prisma.auditLog.count({
      where: { stream: "access", targetType: "file_object", targetId: material },
    });
    await data(
      await api.request(`/api/v1/admin/files/${material}/download-urls`, {
        method: "POST",
        json: {},
        headers: admin.headers,
        peer: `198.19.212.${++peer % 250}`,
      }),
    );
    expect(
      await prisma.auditLog.count({
        where: { stream: "access", targetType: "file_object", targetId: material },
      }),
    ).toBe(accesses + 1);
  });

  it("未配模型的真实文本任务可人工复核；肖像双方补交不自动确认，CAS/重处理/删除各有真实状态", async () => {
    const asset = await createText(),
      id = asset.storeAssetId;
    await reject(
      await request("admin.storeAsset.review", {
        id,
        body: {
          lockVersion: 0,
          contentTagCodes: [],
          usageTagCodes: [],
          timeliness: { tagCode: "unknown" },
          usability: "ready",
        },
      }),
      400,
      "VALIDATION_FAILED",
    );
    await drain(id);
    const reviewed = await review(id, "need_portrait_auth");
    expect(reviewed).toMatchObject({
      processingState: "processed",
      isInsightPartial: true,
      usability: "need_portrait_auth",
    });
    const merchantMaterial = await stored(owner, "portrait_auth"),
      staffMaterial = await stored(admin, "portrait_auth");
    await data(
      await request("m.storeAsset.portraitAuth.create", {
        id,
        body: { fileIds: [merchantMaterial] },
      }),
      "m.storeAsset.portraitAuth.create",
    );
    await data(
      await request("admin.storeAsset.portraitAuth.create", {
        id,
        body: { fileIds: [staffMaterial] },
      }),
      "admin.storeAsset.portraitAuth.create",
    );
    expect(await prisma.storeAsset.findUniqueOrThrow({ where: { id } })).toMatchObject({
      usability: "need_portrait_auth",
      portraitAuthorizedAt: null,
    });
    const confirmed = await data<AdminStoreAssetDetail>(
      await request("admin.storeAsset.confirmPortraitAuth", {
        id,
        body: { lockVersion: reviewed.lockVersion, usability: "ready" },
      }),
      "admin.storeAsset.confirmPortraitAuth",
    );
    expect(confirmed).toMatchObject({
      usability: "ready",
      portraitAuth: { fileCount: 2, authorizedAt: api.clock.now().toISOString() },
    });
    await reject(
      await request("admin.storeAsset.confirmPortraitAuth", {
        id,
        body: { lockVersion: reviewed.lockVersion, usability: "ready" },
      }),
      409,
      "VERSION_CONFLICT",
    );
    await data(
      await request("m.storeAsset.feedback.create", { id, body: { content: "识别结果需要补充" } }),
      "m.storeAsset.feedback.create",
    );
    expect(
      await data(
        await request("admin.storeAsset.reprocess", { id, body: { kinds: ["digest"] } }),
        "admin.storeAsset.reprocess",
      ),
    ).toMatchObject({ processingState: "processing" });
    await drain(id);
    const behalfFile = await stored(admin, "store_asset");
    const behalf = await data<AdminStoreAssetRow>(
      await request("admin.storeAsset.create", {
        body: { storeId: scope.storeId, type: "image", fileIds: [behalfFile] },
      }),
      "admin.storeAsset.create",
    );
    expect(behalf.uploader).toMatchObject({ actorType: "staff", staffId: admin.staff.id });
    await reject(
      await request("admin.storeAsset.delete", {
        id: behalf.storeAssetId,
        body: { reasonText: "" },
      }),
      400,
      "VALIDATION_FAILED",
    );
    await data(
      await request("admin.storeAsset.delete", {
        id: behalf.storeAssetId,
        body: { reasonText: "本轮撤回代传" },
      }),
      "admin.storeAsset.delete",
    );
    const ref = await prisma.fileRef.findFirstOrThrow({
      where: { refId: behalf.storeAssetId, fileId: behalfFile, role: "main" },
    });
    expect(ref).toMatchObject({
      releasedAt: api.clock.now(),
      keepUntil: new Date(api.clock.now().getTime() + 7 * 86_400_000),
    });
    await reject(
      await request("admin.storeAsset.get", { id: behalf.storeAssetId }),
      404,
      "NOT_FOUND",
    );
    expect([...passed].sort()).toEqual([...operations].sort());
    expect([...denied].sort()).toEqual([...operations].sort());
  });

  it("三项桩走实际profile/tenant计数与order参考写；跨店/已删除拒绝且冻结后失败整笔回滚", async () => {
    const asset = await createText("可用于本轮订单的参考");
    await drain(asset.storeAssetId);
    await review(asset.storeAssetId);
    const count = await prisma.storeAsset.count({
      where: { entityId: scope.entityId, storeId: scope.storeId, deletedAt: null },
    });
    const profile = await data<{
      assets: { total: number; recent7dCount: number; recent: StoreAssetCard[] };
    }>(await api.request("/api/v1/m/store-profile", { headers: owner.withStore(scope.storeId) }));
    expect(profile.assets.total).toBe(count);
    expect(profile.assets.recent7dCount).toBe(count);
    expect(profile.assets.recent.length).toBeGreaterThan(0);
    expect(
      profile.assets.recent.some(
        (item) => item.storeAssetId === asset.storeAssetId && item.uploader.isMe,
      ),
    ).toBe(true);
    const stores = await data<{ items: { storeId: string; assetCount: number }[] }>(
      await api.request("/api/v1/m/stores", { headers: owner.headers }),
    );
    expect(stores.items.find((store) => store.storeId === scope.storeId)?.assetCount).toBe(count);
    const fixture = await prepareOrderFixture(prisma, api.runtime, api.clock, {
      ...scope,
      merchantUserId: owner.merchantUserId,
    });
    const input = { ...fixture.input, referenceStoreAssetIds: [asset.storeAssetId] };
    const snapshot = async () => ({
      orders: await prisma.dramaOrder.count(),
      usages: await prisma.storeAssetUsage.count(),
      holds: await prisma.pointHold.count(),
      consents: await prisma.agreementConsent.count(),
      ledger: await prisma.ledgerOperation.count(),
    });
    const before = await snapshot();
    const foreign = await data<StoreAssetCard>(
      await request("m.storeAsset.create", {
        headers: outsider.withStore(outsiderStoreId),
        body: { type: "text", textBody: "他店参考" },
      }),
    );
    for (const id of [uuidv7(), foreign.storeAssetId]) {
      await reject(
        await api.request("/api/v1/m/orders", {
          method: "POST",
          json: { ...input, referenceStoreAssetIds: [id] },
          headers: { ...owner.withStore(scope.storeId), "Idempotency-Key": uuidv7() },
        }),
        400,
        "VALIDATION_FAILED",
      );
      expect(await snapshot()).toEqual(before);
    }
    const emit = api.runtime.events.emit;
    let heldAndLinked = false;
    const failing = vi
      .spyOn(api.runtime.events, "emit")
      .mockImplementation(async (tx, identity, event) => {
        if (event.type === "order.submitted") {
          const orderId = event.aggregate.id;
          expect(
            await tx.storeAssetUsage.findMany({
              where: { usedByType: "drama_order", usedById: orderId },
            }),
          ).toEqual([
            expect.objectContaining({ storeAssetId: asset.storeAssetId, role: "reference" }),
          ]);
          expect(
            await tx.pointHold.count({
              where: { entityId: scope.entityId, refType: "order_item" },
            }),
          ).toBeGreaterThan(0);
          heldAndLinked = true;
          throw new Error("owned test failure after real hold and asset reference");
        }
        return emit(tx, identity, event);
      });
    try {
      await reject(
        await api.request("/api/v1/m/orders", {
          method: "POST",
          json: input,
          headers: { ...owner.withStore(scope.storeId), "Idempotency-Key": uuidv7() },
        }),
        500,
      );
      expect(heldAndLinked).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally {
      failing.mockRestore();
    }
    const order = await data<{ orderId: string; referenceStoreAssetIds: string[] }>(
      await api.request("/api/v1/m/orders", {
        method: "POST",
        json: input,
        headers: { ...owner.withStore(scope.storeId), "Idempotency-Key": uuidv7() },
      }),
    );
    expect(order.referenceStoreAssetIds).toEqual([asset.storeAssetId]);
    expect(await prisma.storeAssetUsage.findMany({ where: { usedById: order.orderId } })).toEqual([
      expect.objectContaining({
        storeAssetId: asset.storeAssetId,
        usedByType: "drama_order",
        role: "reference",
      }),
    ]);
    const linked = await snapshot();
    expect(linked.usages).toBe(before.usages + 1);
    expect(linked.holds).toBe(before.holds + 1);
  });
});
