import { calendarDate } from "@liyoxi/shared/time";
import { uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import type { FileRegistration, StoreAssetCard, StoreAssetDetail } from "@liyoxi/contract";
import { expect } from "vitest";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";

type ClerkContext = { clerk: SignedInMerchant; storeId: string };
type Prepared = { id: string; demandId: string; created: Response };
const prepared = new WeakMap<TestApi, Promise<Prepared>>();

async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
function request(api: TestApi, ctx: ClerkContext, path: string, json?: unknown) {
  return api.request(`/api/v1/m${path}`, {
    method: json === undefined ? "GET" : "POST",
    ...(json === undefined ? {} : { json }),
    headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
  });
}
async function drain(api: TestApi, id: string) {
  for (let step = 0; step < 8; step++) {
    const jobs = await api.runtime.tx.run((tx) =>
      tx.mediaJob.findMany({
        where: {
          parentType: "store_asset",
          parentId: id,
          state: { in: ["queued", "submitted"] },
          nextRunAt: { lte: api.clock.now() },
        },
        orderBy: { id: "asc" },
      }),
    );
    for (const job of jobs) await api.runtime.media.jobs.run({ jobId: job.id });
    const asset = await api.runtime.tx.run((tx) =>
      tx.storeAsset.findUniqueOrThrow({ where: { id } }),
    );
    if (asset.processingState === "processed") return asset;
    expect(jobs.length, "素材必须有真实的到期理解任务").toBeGreaterThan(0);
    api.clock.advance(5_000);
  }
  throw new Error("店员素材样例超过有界任务步数");
}
function prepare(api: TestApi, ctx: ClerkContext): Promise<Prepared> {
  let ready = prepared.get(api);
  if (!ready) {
    ready = (async () => {
      // Existing mall samples have already applied the real seed. Only login/session
      // facts use the shared fixture; demand, review and all seven merchant calls are real APIs.
      const admin = await api.runtime.tx.run((tx) =>
        signInAsStaff(tx, { roleKey: "super_admin", now: api.clock.now() }),
      );
      const adminRequest = (path: string, json: unknown) =>
        api.request(`/api/v1/admin${path}`, {
          method: "POST",
          json,
          headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
        });
      for (const dimension of ["usage", "timeliness"] as const)
        await data(
          await adminRequest("/dict-items", {
            typeKey: "asset_tag",
            name: `测试${dimension}`,
            ext: { dimension },
          }),
        );
      const demand = await data<{ assetDemandId: string }>(
        await adminRequest("/asset-demands", {
          storeId: ctx.storeId,
          title: "店员招牌素材",
          shootingNote: "补充门店招牌制作说明",
          dueDate: calendarDate(api.clock.now()),
          notifyScope: "owner_and_clerks",
        }),
      );
      const created = await request(api, ctx, "/store-assets", {
        type: "text",
        textBody: "门店招牌现做工艺与当日供应说明",
        assetDemandId: demand.assetDemandId,
      });
      const card = await data<StoreAssetCard>(created.clone());
      const asset = await drain(api, card.storeAssetId);
      const tags = await api.runtime.tx.run((tx) =>
        tx.dictItem.findMany({ where: { dictTypeKey: "asset_tag", isEnabled: true } }),
      );
      const code = (dimension: string) => {
        const tag = tags.find(
          (item) => (item.ext as { dimension?: string })?.dimension === dimension,
        );
        expect(tag, `缺正式素材字典维度 ${dimension}`).toBeDefined();
        if (!tag) throw new Error("缺正式素材字典项");
        return tag.code;
      };
      await data(
        await adminRequest(`/store-assets/${card.storeAssetId}/review`, {
          lockVersion: asset.lockVersion,
          contentTagCodes: [code("content")],
          usageTagCodes: [code("usage")],
          timeliness: { tagCode: code("timeliness") },
          usability: "need_portrait_auth",
        }),
      );
      return { id: card.storeAssetId, demandId: demand.assetDemandId, created };
    })();
    prepared.set(api, ready);
  }
  return ready;
}
async function portraitFile(api: TestApi, ctx: ClerkContext) {
  const registered = await data<{ items: FileRegistration[] }>(
    await request(api, ctx, "/files", {
      category: "portrait_auth",
      files: [{ fileName: "portrait.png", sizeBytes: "8", clientToken: uuidv7() }],
    }),
  );
  const file = registered.items[0]!;
  const row = await api.runtime.tx.run((tx) =>
    tx.fileObject.findUniqueOrThrow({ where: { id: file.fileId } }),
  );
  expect(row.bucket).toBe("secure");
  (api.runtime.providers.storage as FakeStorage).put(
    { bucket: "secure", key: file.key },
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/png",
  );
  await data(await request(api, ctx, `/files/${file.fileId}/complete`, {}));
  const job = await api.runtime.tx.run((tx) =>
    tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${file.fileId}` } }),
  );
  await api.runtime.media.promote({ jobId: job.id });
  expect(
    await api.runtime.tx.run((tx) =>
      tx.fileObject.findUniqueOrThrow({ where: { id: file.fileId } }),
    ),
  ).toMatchObject({ status: "stored", bucket: "secure" });
  return file.fileId;
}

export const assetsClerkSamples = [
  {
    operationId: "m.assetDemand.list",
    play: async (api: TestApi, ctx: ClerkContext) => {
      const { demandId } = await prepare(api, ctx);
      const response = await request(api, ctx, "/asset-demands");
      expect(await response.clone().json()).toMatchObject({
        data: {
          items: expect.arrayContaining([
            expect.objectContaining({ assetDemandId: demandId, myUploadCount: 1 }),
          ]),
        },
      });
      return response;
    },
  },
  {
    operationId: "m.storeAsset.create",
    play: async (api: TestApi, ctx: ClerkContext) => (await prepare(api, ctx)).created.clone(),
  },
  {
    operationId: "m.storeAsset.get",
    play: async (api: TestApi, ctx: ClerkContext) => {
      const { id } = await prepare(api, ctx);
      const response = await request(api, ctx, `/store-assets/${id}`);
      const detail = await data<StoreAssetDetail>(response.clone());
      expect(detail.tags.length).toBeGreaterThan(0);
      expect(detail.timeline.length).toBeGreaterThan(0);
      expect(detail.uploader).toMatchObject({ role: "clerk", isMe: true });
      return response;
    },
  },
  {
    operationId: "m.storeAsset.list",
    play: async (api: TestApi, ctx: ClerkContext) => {
      const { id } = await prepare(api, ctx);
      const response = await request(api, ctx, "/store-assets?uploader=me");
      expect(await response.clone().json()).toMatchObject({
        data: { items: expect.arrayContaining([expect.objectContaining({ storeAssetId: id })]) },
      });
      return response;
    },
  },
  {
    operationId: "m.storeAsset.summary",
    play: async (api: TestApi, ctx: ClerkContext) => {
      await prepare(api, ctx);
      const response = await request(api, ctx, "/store-assets/summary");
      expect(await response.clone().json()).toMatchObject({ data: { tabs: { all: 1, text: 1 } } });
      return response;
    },
  },
  {
    operationId: "m.storeAsset.feedback.create",
    play: async (api: TestApi, ctx: ClerkContext) => {
      const { id } = await prepare(api, ctx);
      return request(api, ctx, `/store-assets/${id}/feedback`, {
        content: "招牌制作说明已补充",
        dimension: "content",
      });
    },
  },
  {
    operationId: "m.storeAsset.portraitAuth.create",
    play: async (api: TestApi, ctx: ClerkContext) => {
      const { id } = await prepare(api, ctx);
      const fileId = await portraitFile(api, ctx);
      const response = await request(api, ctx, `/store-assets/${id}/portrait-auth`, {
        fileIds: [fileId],
      });
      expect(await response.clone().json()).toMatchObject({
        data: { portraitAuth: { fileCount: 1 } },
      });
      return response;
    },
  },
];
