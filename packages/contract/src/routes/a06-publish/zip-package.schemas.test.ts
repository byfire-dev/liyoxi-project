import { expect, it } from "vitest";
import { IdSchema } from "../../common/index.js";
import { payloads } from "../../events/media.js";
import { adminDeliveryReleasePack } from "./delivery-releases.js";
import { DeliveryReleasePackResultSchema } from "./delivery-release.schemas.js";

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const building = {
  deliveryReleaseId: id(1),
  zipBundleId: id(2),
  zipState: "building",
  zipGen: 1,
  zipFileId: null,
  publishListFileId: null,
};

it("未就绪响应不暴露缓存文件，就绪必须提供实际ZIP而清单可空", () => {
  for (const zipState of ["none", "building", "failed"])
    expect(DeliveryReleasePackResultSchema.parse({ ...building, zipState })).toEqual({
      ...building,
      zipState,
    });
  expect(DeliveryReleasePackResultSchema.safeParse({ ...building, zipFileId: id(3) }).success).toBe(
    false,
  );
  expect(
    DeliveryReleasePackResultSchema.safeParse({ ...building, publishListFileId: id(4) }).success,
  ).toBe(false);
  expect(
    DeliveryReleasePackResultSchema.safeParse({ ...building, zipState: "ready" }).success,
  ).toBe(false);
  expect(
    DeliveryReleasePackResultSchema.safeParse({ ...building, zipState: "ready", zipFileId: id(3) })
      .success,
  ).toBe(true);
  for (const zipGen of [0, -1, 1.5])
    expect(DeliveryReleasePackResultSchema.safeParse({ ...building, zipGen }).success).toBe(false);
  expect(IdSchema.safeParse(null).success).toBe(false);
});

it("后台预打包只接收空体，源对象与代次由服务端确定", () => {
  const body = adminDeliveryReleasePack.request.body.content["application/json"].schema;
  expect(body.parse({})).toEqual({});
  for (const input of [{ retry: false }, { zipGen: 2 }, { items: [] }, { key: "other/file.zip" }])
    expect(body.safeParse(input).success).toBe(false);
});

it("ZIP完成事件只携带缓存属主及代次，不携带下载地址或客户端对象键", () => {
  const schema = payloads["media.release.zip_ready"];
  const fact = {
    v: 1,
    zipBundleId: id(2),
    ownerType: "delivery_release",
    ownerId: id(1),
    zipGen: 1,
  };
  expect(schema.parse(fact)).toEqual(fact);
  for (const patch of [
    { ownerType: "order_item" },
    { zipGen: 0 },
    { url: "https://example.com/file.zip" },
  ])
    expect(schema.safeParse({ ...fact, ...patch }).success).toBe(false);
});
