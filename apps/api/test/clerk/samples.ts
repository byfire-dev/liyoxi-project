// 每个商家接口包在这里登记生产处理器的回放。样例用真实鉴权；测试直接建店员成员关系。
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
