import { describe, expect, it } from "vitest";
import { ApiError } from "../../../lib/request";
import { createIntent, errorInfo, generationGuard, parseFen } from "./model";
import { createProfileApi } from "./api";
describe("建档请求与意图边界", () => {
  it("失败重试同键、改变输入换键，同步重复触发只一次", async () => {
    let count = 0;
    const intent = createIntent(() => `key:${++count}`),
      seen: string[] = [];
    const failing = async (key: string) => {
      seen.push(key);
      throw new Error("断网");
    };
    await expect(intent.run({ name: "a" }, failing)).rejects.toThrow();
    await expect(intent.run({ name: "a" }, failing)).rejects.toThrow();
    await expect(intent.run({ name: "b" }, failing)).rejects.toThrow();
    expect(seen).toEqual(["key:1", "key:1", "key:2"]);
    let resolve!: (value: string) => void;
    const first = intent.run(
      { name: "c" },
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    expect(await intent.run({ name: "c" }, failing)).toBeUndefined();
    resolve("ok");
    await first;
    expect(seen).toHaveLength(3);
  });
  it("VERSION_CONFLICT仅提示核对；缺项按真实step定位，不计算完成度", () => {
    const conflict = errorInfo(
      new ApiError({ error: "VERSION_CONFLICT", message: "冲突", status: 409, requestId: "test" }),
    );
    expect(conflict.conflict).toBe(true);
    expect(conflict.message).toContain("已保留本次输入");
    const missing = errorInfo(
      new ApiError({
        error: "STORE_PROFILE_INCOMPLETE",
        message: "缺项",
        status: 409,
        requestId: "test",
        details: { missing: [{ step: 4, item: "permit", permitType: "food_business" }] },
      }),
    );
    expect(missing.step).toBe(4);
    expect(missing.missing).toEqual(["行业许可证"]);
    const declaration = errorInfo(
      new ApiError({
        error: "DECLARATION_REQUIRED",
        message: "旧确认",
        status: 409,
        requestId: "test",
        details: { currentVersion: "2" },
      }),
    );
    expect(declaration.conflict).toBe(true);
    expect(declaration.message).toContain("重新阅读并确认");
  });
  it("切店或关闭后旧响应不成为新聚合", async () => {
    let context = "store1";
    const guard = generationGuard(() => context);
    let resolve!: (value: string) => void;
    const run = guard.run(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    context = "store2";
    resolve("old");
    expect(await run).toBeUndefined();
    const run2 = guard.run(() => Promise.resolve("late"));
    guard.invalidate();
    expect(await run2).toBeUndefined();
  });
  it("提交发送本次声明与当前版本；字典使用typeKey，PATCH显式null不会丢", async () => {
    const calls: [string, unknown][] = [];
    const api = createProfileApi(async <T>(path: string, options?: unknown) => {
      calls.push([path, options]);
      return { items: [] } as T;
    });
    await api.create("create:1");
    await api.saveBasic(
      {
        draft: true,
        lockVersion: 2,
        brandName: null,
        storeName: null,
        industryCode: null,
        categoryCode: null,
        address: null,
      },
      "save:1",
    );
    await api.submit(
      { qualificationSubmissionId: "round", declarationConfirmed: true, declarationVersion: "new" },
      "submit:1",
    );
    await api.dict("industry,region");
    expect(calls[0]).toEqual([
      "/m/entities",
      { method: "POST", data: {}, idempotencyKey: "create:1" },
    ]);
    expect(calls[1]).toEqual([
      "/m/store-profile/basic",
      {
        method: "PATCH",
        data: {
          draft: true,
          lockVersion: 2,
          brandName: null,
          storeName: null,
          industryCode: null,
          categoryCode: null,
          address: null,
        },
        idempotencyKey: "save:1",
      },
    ]);
    expect(calls[2]).toEqual([
      "/m/store-profile/qualification/submit",
      {
        method: "POST",
        data: {
          qualificationSubmissionId: "round",
          declarationConfirmed: true,
          declarationVersion: "new",
        },
        idempotencyKey: "submit:1",
      },
    ]);
    expect(calls[3]?.[0]).toBe("/m/dict-items?typeKey=industry%2Cregion&includeDisabled=true");
  });
  it("输入金额只无损转分，拒绝三位小数与不安全整数", () => {
    expect(parseFen("0.10")).toBe(10);
    expect(parseFen("28")).toBe(2800);
    expect(parseFen("")).toBeNull();
    expect(() => parseFen("1.111")).toThrow();
    expect(() => parseFen("999999999999999999999")).toThrow();
  });
  it("媒体、服务、主体、联系人与手填证照分别使用真实资源路径与当前锁；不丢null或补原号", async () => {
    const calls: { path: string; options: unknown }[] = [];
    const api = createProfileApi(async <T>(path: string, options?: unknown) => {
      calls.push({ path, options });
      return {} as T;
    });
    const media = {
      draft: true,
      lockVersion: 4,
      groups: {
        door: [{ fileId: "door" }],
        interior: [{ fileId: "inside" }],
        product: [],
        promo: [],
      },
    };
    const service = {
      draft: true,
      lockVersion: 5,
      serviceItems: [
        { name: "咖啡", priceFen: 2900, originalPriceFen: null, imageFileId: null, intro: null },
      ],
      promoText: null,
      groupBuyText: null,
      sellingPointCodes: ["fresh"],
      sellingNote: null,
    };
    const round = { lockVersion: null, claimedEntityType: "enterprise" as const };
    const contact = { lockVersion: 3, name: "林店长", phoneSource: "login" as const };
    const document = { fileId: "stored", docType: "business_license" as const };
    const fields = { lockVersion: 7, fields: { validTo: "long_term", uscc: "91440300XXXXXXXXXX" } };
    await api.saveMedia(media, "media:4");
    await api.saveService(service, "service:5");
    await api.saveQualification(round, "round:1");
    await api.saveContact(contact, "contact:3");
    await api.createDoc(document, "doc:1");
    await api.saveDoc("doc-id", fields, "fields:7");
    expect(calls).toEqual([
      {
        path: "/m/store-profile/media",
        options: { method: "PATCH", data: media, idempotencyKey: "media:4" },
      },
      {
        path: "/m/store-profile/service",
        options: { method: "PATCH", data: service, idempotencyKey: "service:5" },
      },
      {
        path: "/m/store-profile/qualification",
        options: { method: "PATCH", data: round, idempotencyKey: "round:1" },
      },
      {
        path: "/m/store-profile/contact",
        options: { method: "PATCH", data: contact, idempotencyKey: "contact:3" },
      },
      {
        path: "/m/qualification-docs",
        options: { method: "POST", data: document, idempotencyKey: "doc:1" },
      },
      {
        path: "/m/qualification-docs/doc-id",
        options: { method: "PATCH", data: fields, idempotencyKey: "fields:7" },
      },
    ]);
  });
});
