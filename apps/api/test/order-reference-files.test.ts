import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AdminOrderDetail,
  FileRegistration,
  MaterialDownloadResult,
  OrderCreateResult,
  StoreAssetCard,
} from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { prepareOrderFixture, signInAsStaff } from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  admin: SignedInStaff,
  manager: SignedInStaff,
  other: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let scope: { entityId: string; storeId: string; memberId: string };
let fixture: Awaited<ReturnType<typeof prepareOrderFixture>>;
let order: OrderCreateResult, asset: StoreAssetCard, fileIds: string[], ticketId: string;
let peer = 0;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const storage = () => api.runtime.providers.storage as FakeStorage;
async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
const merchant = (path: string, method = "GET", json?: unknown, key = uuidv7()) =>
  api.request(`/api/v1/m${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...owner.withStore(scope.storeId), "Idempotency-Key": key },
    peer: `198.19.153.${++peer % 250}`,
  });
const staff = (path: string, actor = admin, method = "GET", json?: unknown) =>
  api.request(`/api/v1/admin${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...actor.headers, "Idempotency-Key": uuidv7() },
    peer: `198.19.153.${++peer % 250}`,
  });
async function upload(category = "store_asset") {
  const registered = await data<{ items: FileRegistration[] }>(
    await merchant("/files", "POST", {
      category,
      files: [{ fileName: "订单参考.png", sizeBytes: String(png.length), clientToken: uuidv7() }],
    }),
  );
  const registration = registered.items[0]!;
  const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: registration.fileId } });
  storage().put(
    { bucket: file.incomingBucket as "asset", key: file.incomingKey! },
    png,
    "image/png",
  );
  await data(await merchant(`/files/${file.id}/complete`, "POST", {}));
  const job = await prisma.mediaJob.findUniqueOrThrow({
    where: { dedupeKey: `promote:${file.id}` },
  });
  await api.runtime.media.promote({ jobId: job.id });
  return file.id;
}
const writes = async () => ({
  refs: await prisma.fileRef.findMany({
    where: { refType: "drama_order", refId: order.orderId },
    orderBy: { fileId: "asc" },
  }),
  usage: await prisma.storeAssetUsage.count(),
  audit: await prisma.auditLog.count(),
  ledger: await prisma.ledgerOperation.count(),
  checkout: await prisma.masterCheckout.count(),
  idempotency: await prisma.idempotencyRecord.count(),
});
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
  fixture = await prepareOrderFixture(prisma, api.runtime, api.clock, {
    ...scope,
    merchantUserId: owner.merchantUserId,
  });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  manager = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  other = await signInAsStaff(prisma, { roleKey: "delivery_manager", now: api.clock.now() });
  fileIds = [await upload(), await upload()];
  asset = await data<StoreAssetCard>(
    await merchant("/store-assets", "POST", { type: "image", fileIds }),
  );
  order = await data<OrderCreateResult>(
    await merchant("/orders", "POST", {
      ...fixture.input,
      referenceStoreAssetIds: [asset.storeAssetId],
    }),
  );
}, 120_000);

describe("订单参考文件的真实HTTP投影与取料链", { timeout: 60_000 }, () => {
  it("真实上传→素材→下单双关联→后台只读缩略图→实际扣减开工→材料接口签发", async () => {
    expect(
      await prisma.fileRef.findMany({
        where: { refType: "drama_order", refId: order.orderId, role: "reference", state: "live" },
        orderBy: { fileId: "asc" },
      }),
    ).toEqual([...fileIds].sort().map((fileId) => expect.objectContaining({ fileId })));
    const before = await writes();
    const response = await staff(`/orders/${order.orderId}`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const detail = await data<AdminOrderDetail>(response);
    expect(detail.referenceFiles.map((file) => file.fileId)).toEqual([...fileIds].sort());
    for (const file of detail.referenceFiles) {
      expect(file).toMatchObject({
        source: "store_asset",
        storeAssetId: asset.storeAssetId,
        type: "image",
        mediaGroup: null,
      });
      expect(file.thumbnail?.url).toEqual(expect.any(String));
      expect(storage().fetch(file.thumbnail!.url).status).toBe(200);
    }
    expect(await writes()).toEqual(before);
    const timer = await prisma.timer.findFirstOrThrow({
      where: { kind: "order.start", subjectId: order.orderId },
    });
    // 调用已装配的正式开工handler；扣减/状态/工单由真实公口完成，不造captured或ready行。
    expect(
      await api.runtime.tx.run((tx) =>
        api.runtime.assembly.timerHandler("order.start")!.handle(tx, {
          id: timer.id,
          kind: timer.kind,
          subjectType: timer.subjectType,
          subjectId: timer.subjectId,
          payload: null,
        }),
      ),
    ).toBe("fired");
    const ticket = await prisma.deliveryTicket.findFirstOrThrow({
      where: { dramaOrderId: order.orderId },
    });
    ticketId = ticket.id;
    expect(
      await prisma.pointHold.count({ where: { entityId: scope.entityId, status: "captured" } }),
    ).toBe(1);
    const materials = await data<{ storeAssets: Array<{ storeAssetId: string }> }>(
      await staff(`/delivery-tickets/${ticketId}/materials`),
    );
    expect(materials.storeAssets).toEqual([
      expect.objectContaining({ storeAssetId: asset.storeAssetId }),
    ]);
    const urls = await data<MaterialDownloadResult>(
      await staff(`/delivery-tickets/${ticketId}/materials/download-urls`, admin, "POST", {
        kind: "store_asset",
        storeAssetId: asset.storeAssetId,
      }),
    );
    expect(urls.items.map((file) => file.fileId).sort()).toEqual([...fileIds].sort());
    for (const file of urls.items) expect(storage().fetch(file.url).status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { stream: "access", targetId: { in: fileIds }, action: "files.url.sign" },
      }),
    ).toBe(2);
  });

  it("当前内容安全拦截保留参考元数据但不签缩略图，其他负责人范围404", async () => {
    await prisma.fileObject.updateMany({
      where: { id: { in: fileIds } },
      data: { moderationState: "block" },
    });
    try {
      const before = storage().callsOf("presignGet").length;
      const detail = await data<AdminOrderDetail>(await staff(`/orders/${order.orderId}`));
      expect(detail.referenceFiles).toHaveLength(2);
      expect(detail.referenceFiles.every((file) => file.thumbnail === null)).toBe(true);
      expect(storage().callsOf("presignGet")).toHaveLength(before);
      const response = await staff(`/orders/${order.orderId}`, other);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "NOT_FOUND" });
    } finally {
      await prisma.fileObject.updateMany({
        where: { id: { in: fileIds } },
        data: { moderationState: "none" },
      });
    }
  });

  it("既有合法档案参考保留已移除媒体映射，GET不补写且materials仍按本单引用取用", async () => {
    const fileId = await upload("profile_image");
    const current = await prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: scope.storeId },
    });
    await data(
      await merchant("/store-profile/media", "PATCH", {
        draft: true,
        lockVersion: current.lockVersion,
        groups: { product: [{ fileId }] },
      }),
    );
    // 仅准备历史已登记关系；不新增订单档案输入或自动复制producer。
    await api.runtime.tx.run((tx) =>
      api.runtime.media.link(tx, {
        fileId,
        refType: "drama_order",
        refId: order.orderId,
        role: "reference",
        entityId: scope.entityId,
        storeId: scope.storeId,
      }),
    );
    const linked = await prisma.storeProfile.findUniqueOrThrow({
      where: { storeId: scope.storeId },
    });
    await data(
      await merchant("/store-profile/media", "PATCH", {
        draft: true,
        lockVersion: linked.lockVersion,
        groups: { product: [] },
      }),
    );
    const before = await writes();
    const detail = await data<AdminOrderDetail>(await staff(`/orders/${order.orderId}`));
    expect(detail.referenceFiles.find((file) => file.fileId === fileId)).toMatchObject({
      source: "profile_media",
      mediaGroup: "product",
      type: "image",
      storeAssetId: null,
      thumbnail: { url: expect.any(String) },
    });
    expect(await writes()).toEqual(before);
    const urls = await data<MaterialDownloadResult>(
      await staff(`/delivery-tickets/${ticketId}/materials/download-urls`, admin, "POST", {
        kind: "profile_media",
        fileId,
      }),
    );
    expect(urls.items[0]!.fileId).toBe(fileId);
    expect(storage().fetch(urls.items[0]!.url).status).toBe(200);
  });

  it.each(["file", "reference", "scope"] as const)(
    "签名期间%s事实变化拒绝回传旧URL",
    async (change) => {
      await prisma.store.update({
        where: { id: scope.storeId },
        data: { deliveryManagerId: manager.staff.id },
      });
      const actual = api.runtime.media.signRead;
      const sign = vi.spyOn(api.runtime.media, "signRead").mockImplementationOnce(async (input) => {
        const signed = await actual(input);
        if (change === "file")
          await prisma.fileObject.update({
            where: { id: input.fileId },
            data: { moderationState: "block" },
          });
        else if (change === "scope")
          await prisma.store.update({
            where: { id: scope.storeId },
            data: { deliveryManagerId: other.staff.id },
          });
        else
          await prisma.fileRef.updateMany({
            where: {
              refType: "drama_order",
              refId: order.orderId,
              fileId: input.fileId,
              role: "reference",
            },
            data: {
              state: "released",
              releasedAt: api.clock.now(),
              keepUntil: new Date(api.clock.now().getTime() + 90 * 86_400_000),
            },
          });
        return signed;
      });
      try {
        const response = await staff(`/orders/${order.orderId}`, manager);
        expect(response.status).toBe(change === "scope" ? 404 : 409);
        expect(await response.json()).toMatchObject({
          error: change === "scope" ? "NOT_FOUND" : "FILE_NOT_AVAILABLE",
        });
      } finally {
        sign.mockRestore();
        await prisma.fileObject.updateMany({
          where: { id: { in: fileIds } },
          data: { moderationState: "none" },
        });
        for (const fileId of fileIds)
          await api.runtime.tx.run((tx) =>
            api.runtime.media.link(tx, {
              fileId,
              refType: "drama_order",
              refId: order.orderId,
              role: "reference",
              entityId: scope.entityId,
              storeId: scope.storeId,
            }),
          );
        await prisma.store.update({
          where: { id: scope.storeId },
          data: { deliveryManagerId: null },
        });
      }
    },
  );
});
