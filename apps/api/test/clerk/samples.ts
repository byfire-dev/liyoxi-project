// 每个商家接口包在这里登记生产处理器的回放。样例用真实鉴权；测试直接建店员成员关系。
import { uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import { expect } from "vitest";
import type { TestApi, TestRequestInit } from "../../src/testing/index.js";
import { currentUserConsents, presetLoginCodes } from "../../src/testing/merchant.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";

export interface ClerkSampleContext {
  clerk: SignedInMerchant;
  storeId: string;
  agreementVersionId: string;
}
interface Sample {
  operationId: string;
  /** 只用于接口本身的真实错误场景；旧样例缺省仍为 200。none 仍固定 403。 */
  expectedStatus?: number;
  play(api: TestApi, context: ClerkSampleContext): Promise<Response>;
}
const get = (operationId: string, path: string): Sample => ({
  operationId,
  play: async (api, ctx) =>
    api.request(`/api/v1${path}`, { headers: ctx.clerk.withStore(ctx.storeId) }),
});
// 四个自读操作回放店员本人已有的登记。M1 创建能力仍不开放给店员；这里只由测试工厂造前置行。
const clerkFile = (api: TestApi, ctx: ClerkSampleContext) =>
  api.runtime.tx.run(async (tx) => {
    const store = await tx.store.findUniqueOrThrow({ where: { id: ctx.storeId } });
    const id = uuidv7();
    return createFactories({ db: tx, clock: api.clock }).fileObject({
      id,
      category: "profile_image",
      bucket: "asset",
      ext: "png",
      scopeType: "store",
      entityId: store.entityId,
      storeId: ctx.storeId,
      uploadActorType: "merchant",
      uploadActorId: ctx.clerk.merchantUserId,
      uploadClient: "weapp",
      uploadMode: "post",
      clientToken: uuidv7(),
      originalName: "photo.png",
      declaredSize: 8,
      declaredMime: "image/png",
      incomingBucket: "asset",
      incomingKey: `incoming/${id}/photo.png`,
      uploadExpiresAt: new Date(api.clock.now().getTime() + 86_400_000),
      status: "pending",
      storedAt: null,
      sizeBytes: null,
      mime: null,
    });
  });
const playClerkFile = (operationId: string, action?: string): Sample => ({
  operationId,
  play: async (api, ctx) => {
    const file = await clerkFile(api, ctx);
    if (action === "complete")
      (api.runtime.providers.storage as FakeStorage).put(
        { bucket: "asset", key: file.incomingKey! },
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/png",
      );
    return api.request(`/api/v1/m/files/${file.id}${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET",
      ...(action ? { json: {} } : {}),
      headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
    });
  },
});
export const CLERK_SAMPLES: readonly Sample[] = [
  get("m.agreement.list", "/m/agreements"),
  {
    operationId: "m.agreementVersion.get",
    play: async (api, ctx) =>
      api.request(`/api/v1/m/agreement-versions/${ctx.agreementVersionId}`, {
        headers: ctx.clerk.headers,
      }),
  },
  get("m.bootstrap.get", "/m/bootstrap"),
  get("m.me.get", "/m/me"),
  get("m.me.overview.get", "/m/me/overview"),
  {
    operationId: "m.session.create",
    play: async (api, ctx) =>
      api.request("/api/v1/m/sessions", {
        method: "POST",
        json: { loginCode: presetLoginCodes(api, ctx.clerk).loginCode },
        headers: ctx.clerk.headers,
      }),
  },
  {
    operationId: "m.session.phoneLogin",
    play: async (api, ctx) =>
      api.request("/api/v1/m/sessions/phone-login", {
        method: "POST",
        json: { ...presetLoginCodes(api, ctx.clerk), consents: await currentUserConsents(api) },
        headers: ctx.clerk.headers,
      }),
  },
  {
    operationId: "m.agreementConsent.create",
    play: async (api, ctx) =>
      api.request("/api/v1/m/agreement-consents", {
        method: "POST",
        json: { consents: await currentUserConsents(api) },
        headers: ctx.clerk.headers,
      }),
  },
  get("m.agreementConsent.list", "/m/agreement-consents"),
  get("m.agreementConsent.summary", "/m/agreement-consents/summary"),
  {
    operationId: "m.entity.create",
    expectedStatus: 409,
    play: async (api, ctx) =>
      api.request("/api/v1/m/entities", {
        method: "POST",
        json: {},
        headers: { ...ctx.clerk.headers, "Idempotency-Key": "clerk-create-entity" },
      }),
  },
  get("m.store.list", "/m/stores"),
  {
    operationId: "m.me.currentStore.replace",
    play: async (api, ctx) =>
      api.request("/api/v1/m/me/current-store", {
        method: "PUT",
        json: { storeId: ctx.storeId },
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": "clerk-current-store" },
      }),
  },
  get("m.dictItem.list", "/m/dict-items?typeKey=ticket_type"),
  {
    operationId: "m.file.create",
    expectedStatus: 403,
    play: async (api, ctx) => {
      const response = await api.request("/api/v1/m/files", {
        method: "POST",
        json: {
          category: "profile_image",
          files: [{ fileName: "photo.png", sizeBytes: "8", clientToken: uuidv7() }],
        },
        headers: ctx.clerk.withStore(ctx.storeId),
      });
      expect(((await response.clone().json()) as { error: string }).error).toBe("ROLE_FORBIDDEN");
      return response;
    },
  },
  playClerkFile("m.file.get"),
  playClerkFile("m.file.refreshCredentials", "refresh-credentials"),
  playClerkFile("m.file.complete", "complete"),
  playClerkFile("m.file.cancel", "cancel"),
  // 退出会吊销当前凭据，放到这一份样例的最后。其它样例不得靠退出后的身份。
  {
    operationId: "m.session.current.delete",
    play: async (api, ctx) =>
      api.request("/api/v1/m/sessions/current", {
        method: "DELETE",
        headers: ctx.clerk.headers,
      } satisfies TestRequestInit),
  },
];
