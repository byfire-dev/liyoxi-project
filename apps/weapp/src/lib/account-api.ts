import type { components, operations } from "@liyoxi/contract/types/merchant";
import type { RequestLayer } from "./request";

export type Data<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { "application/json": { data: infer D } } } };
}
  ? D
  : never;
export type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type Me = components["schemas"]["MeView"];
export type PendingConsent = components["schemas"]["PendingConsent"];
export type Overview = Data<"m.me.overview.get">;
export type StoreList = Data<"m.store.list">;
export type Agreement = components["schemas"]["AgreementCurrent"];
export type Attribution = components["schemas"]["Attribution"];

/** 唯一生产调用入口是 runtime.request；离线截图与单测只注入此函数。 */
export function createAccountApi(request: RequestLayer["request"]) {
  return {
    bootstrap: () => request<Data<"m.bootstrap.get">>("/m/bootstrap"),
    silent: (loginCode: string) =>
      request<Data<"m.session.create">>("/m/sessions", {
        method: "POST",
        auth: false,
        data: { loginCode } satisfies Body<"m.session.create">,
      }),
    phone: (data: Body<"m.session.phoneLogin">) =>
      request<Data<"m.session.phoneLogin">>("/m/sessions/phone-login", {
        method: "POST",
        auth: false,
        data,
      }),
    me: () => request<Me>("/m/me"),
    overview: () => request<Overview>("/m/me/overview"),
    logout: () => request<null>("/m/sessions/current", { method: "DELETE" }),
    agreements: async () => {
      const items: Agreement[] = [];
      let cursor: string | null = null;
      do {
        const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const page: Data<"m.agreement.list"> = await request(
          `/m/agreements?scene=login&limit=50${query}`,
          { auth: false },
        );
        items.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor);
      return items.filter((item) => item.currentVersion !== null);
    },
    agreement: (id: string) =>
      request<Data<"m.agreementVersion.get">>(`/m/agreement-versions/${encodeURIComponent(id)}`, {
        auth: false,
      }),
    consent: (consents: PendingConsent[]) =>
      request<Data<"m.agreementConsent.create">>("/m/agreement-consents", {
        method: "POST",
        data: {
          consents: consents.map(({ agreementKey, agreementVersionId }) => ({
            agreementKey,
            agreementVersionId,
          })),
        } satisfies Body<"m.agreementConsent.create">,
      }),
    stores: () => request<StoreList>("/m/stores"),
    remember: (storeId: string, idempotencyKey: string) =>
      request<Data<"m.me.currentStore.replace">>("/m/me/current-store", {
        method: "PUT",
        data: { storeId } satisfies Body<"m.me.currentStore.replace">,
        idempotencyKey,
      }),
  };
}
export type AccountApi = ReturnType<typeof createAccountApi>;
