// 每个商家接口包在这里登记生产处理器的回放。样例用真实鉴权；测试直接建店员成员关系。
import { mallClerkSamples } from "./mall-samples.js";
import { orderClerkSamples } from "./order-samples.js";
import { messageClerkSamples } from "./messages-samples.js";
import { reportingClerkSamples } from "./reporting-samples.js";
import { assetsClerkSamples } from "./assets-samples.js";
import { createIdentityContext } from "@liyoxi/services";
import { merchantServicesOf } from "../../src/merchant/services.js";
import { uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import type { FakeStorage } from "@liyoxi/services/testing";
import { expect } from "vitest";
import type { TestApi, TestRequestInit } from "../../src/testing/index.js";
import {
  currentUserConsents,
  presetLoginCodes,
  signInAsMerchant,
} from "../../src/testing/merchant.js";
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
  ...messageClerkSamples,
  ...reportingClerkSamples,
  get("m.orderItem.release.get", `/m/order-items/${uuidv7()}/release`),
  ...(
    [
      ["m.sample.downloadUrls", `/m/samples/${uuidv7()}/download-urls`, {}],
      [
        "m.orderItem.downloadUrls",
        `/m/order-items/${uuidv7()}/download-urls`,
        { kind: "episode", episodeNo: 1 },
      ],
    ] as const
  ).map(([operationId, path, json]): Sample => ({
    operationId,
    play: async (api, ctx) =>
      api.request(`/api/v1${path}`, {
        method: "POST",
        json,
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  })),
  get("m.deliveryPlan.get", `/m/delivery-plans/${uuidv7()}`),
  ...(
    [
      ["m.deliveryPlan.confirm", "confirm", { versionNo: 1 }],
      ["m.deliveryPlan.requestChange", "request-change", { kinds: ["other"], note: "调整方案" }],
    ] as const
  ).map(([operationId, action, json]): Sample => ({
    operationId,
    play: async (api, ctx) =>
      api.request(`/api/v1/m/delivery-plans/${uuidv7()}/${action}`, {
        method: "POST",
        json,
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  })),
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
  {
    operationId: "m.member.remove",
    play: async (api, ctx) =>
      api.request(`/api/v1/m/members/${uuidv7()}/remove`, {
        method: "POST",
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  },
  {
    operationId: "m.me.membership.leave",
    play: async (api, ctx) => {
      // 独立店员真实退出，保留其他既有回放使用的原店员成员关系。
      const leaving = await signInAsMerchant(api);
      await api.runtime.tx.run(async (tx) => {
        const store = await tx.store.findUniqueOrThrow({ where: { id: ctx.storeId } });
        const make = createFactories({ db: tx, clock: api.clock });
        const member = await make.entityMember({
          entityId: store.entityId,
          merchantUserId: leaving.merchantUserId,
        });
        await make.storeMember({ entityMemberId: member.id, storeId: ctx.storeId });
      });
      return api.request("/api/v1/m/me/membership/leave", {
        method: "POST",
        headers: { ...leaving.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      });
    },
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
  get("m.wallet.get", "/m/wallet"),
  get("m.purchasePolicy.get", "/m/purchase-policy"),
  get("m.plan.list", "/m/plans"),
  get("m.paymentOrder.get", `/m/payment-orders/${uuidv7()}`),
  ...[
    { operationId: "m.plan.quote", path: "/m/plans/quote", json: { planId: uuidv7(), months: 1 } },
    {
      operationId: "m.paymentOrder.create",
      path: "/m/payment-orders",
      json: {
        planId: uuidv7(),
        months: 1,
        channel: "bank_transfer",
        expectAmountFen: 1,
        agreementVersionIds: [uuidv7(), uuidv7()],
      },
    },
    {
      operationId: "m.paymentOrder.transferProof.create",
      path: `/m/payment-orders/${uuidv7()}/transfer-proofs`,
      json: { fileId: uuidv7() },
    },
  ].map(({ operationId, path, json }): Sample => ({
    operationId,
    play: async (api, ctx) =>
      api.request(`/api/v1${path}`, {
        method: "POST",
        json,
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  })),
  get("m.storeProfile.get", "/m/store-profile"),
  get("m.storeProfile.basic.get", "/m/store-profile/basic"),
  get("m.storeProfile.media.get", "/m/store-profile/media"),
  {
    operationId: "m.storeProfile.service.get",
    play: async (api, ctx) => {
      await api.runtime.tx.run(async (tx) => {
        const store = await tx.store.findUniqueOrThrow({ where: { id: ctx.storeId } });
        const now = api.clock.now();
        await tx.storeProfile.create({
          data: { storeId: store.id, entityId: store.entityId, createdAt: now, updatedAt: now },
        });
        await tx.storeServiceItem.create({
          data: {
            id: uuidv7(),
            entityId: store.entityId,
            storeId: store.id,
            position: 1,
            name: "公开服务",
            priceFen: 1000,
            originalPriceFen: 1500,
            createdAt: now,
            updatedAt: now,
          },
        });
      });
      const response = await api.request("/api/v1/m/store-profile/service", {
        headers: ctx.clerk.withStore(ctx.storeId),
      });
      expect(
        ((await response.clone().json()) as { data: { serviceItems: unknown[] } }).data
          .serviceItems,
      ).toMatchObject([{ priceFen: 1000, originalPriceFen: 1500 }]);
      return response;
    },
  },
  get("m.storeProfile.qualification.get", "/m/store-profile/qualification"),
  ...[
    ["m.storeProfile.basic.update", "PATCH", "/m/store-profile/basic"],
    ["m.storeProfile.media.update", "PATCH", "/m/store-profile/media"],
    ["m.storeProfile.service.update", "PATCH", "/m/store-profile/service"],
    ["m.storeProfile.qualification.update", "PATCH", "/m/store-profile/qualification"],
    ["m.storeProfile.contact.update", "PATCH", "/m/store-profile/contact"],
    ["m.storeProfile.qualification.submit", "POST", "/m/store-profile/qualification/submit"],
    ["m.qualificationDoc.create", "POST", "/m/qualification-docs"],
    ["m.qualificationDoc.update", "PATCH", `/m/qualification-docs/${uuidv7()}`],
  ].map(([operationId, method, path]): Sample => ({
    operationId: operationId!,
    play: (api, ctx) =>
      api.request(`/api/v1${path}`, {
        method,
        json: {},
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  })),
  ...[
    ["m.channelAccount.list", "GET", "/m/channel-accounts"],
    ["m.channelAccount.create", "POST", "/m/channel-accounts"],
    ["m.channelAccount.submit", "POST", `/m/channel-accounts/${uuidv7()}/submit`],
    ["m.launchTask.list", "GET", "/m/launch-tasks"],
    ["m.launchTask.summary", "GET", "/m/launch-tasks/summary"],
    ["m.launchTask.get", "GET", `/m/launch-tasks/${uuidv7()}`],
    ["m.launchTask.submit", "POST", `/m/launch-tasks/${uuidv7()}/submit`],
  ].map(([operationId, method, path]): Sample => ({
    operationId: operationId!,
    play: (api, ctx) =>
      api.request(`/api/v1${path}`, {
        method,
        ...(method === "POST" ? { json: {} } : {}),
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  })),
  ...[
    ["m.orderItem.sample.get", "GET", `/m/order-items/${uuidv7()}/sample`],
    ["m.sample.confirm", "POST", `/m/samples/${uuidv7()}/confirm`],
  ].map(([operationId, method, path]): Sample => ({
    operationId: operationId!,
    play: (api, ctx) =>
      api.request(`/api/v1${path}`, {
        method,
        ...(method === "POST" ? { json: {} } : {}),
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  })),
  ...mallClerkSamples,
  ...orderClerkSamples,
  ...assetsClerkSamples,
  get("m.member.list", "/m/members"),
  {
    operationId: "m.member.update",
    play: (api, ctx) =>
      api.request(`/api/v1/m/members/${uuidv7()}`, {
        method: "PATCH",
        json: { storeIds: [ctx.storeId] },
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  },
  ...[
    ["m.invitation.create", "/m/invitations", { clientRequestId: uuidv7() }],
    ["m.invitation.markShared", `/m/invitations/${uuidv7()}/mark-shared`, {}],
    ["m.invitation.revoke", `/m/invitations/${uuidv7()}/revoke`, { reason: "by_owner" }],
  ].map(([operationId, path, body]): Sample => ({
    operationId: String(operationId),
    play: (api, ctx) =>
      api.request(`/api/v1${String(path)}`, {
        method: "POST",
        json: body,
        headers: { ...ctx.clerk.withStore(ctx.storeId), "Idempotency-Key": uuidv7() },
      }),
  })),
  {
    operationId: "m.invitation.lookup",
    play: async (api, ctx) => {
      const owner = await api.runtime.tx.run(async (tx) => {
        const store = await tx.store.findUniqueOrThrow({ where: { id: ctx.storeId } });
        return tx.entityMember.findFirstOrThrow({
          where: { entityId: store.entityId, role: "owner", status: "active" },
        });
      });
      const card = await merchantServicesOf(api.runtime).tenant.createInvitation(
        createIdentityContext({
          actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
          entityId: owner.entityId,
          storeId: ctx.storeId,
        }),
        { clientRequestId: uuidv7() },
      );
      return api.request(`/api/v1/m/invitations/lookup?token=${card.token}`, {
        headers: ctx.clerk.headers,
      });
    },
  },
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
