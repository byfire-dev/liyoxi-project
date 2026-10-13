import type { operations } from "@liyoxi/contract/types/merchant";
import type { RequestLayer } from "@/lib/request";

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
export type Me = Data<"m.me.get">;
export type Identity = Data<"m.me.wechatIdentity.list">["items"][number];
export type Agreement = Data<"m.agreement.list">["items"][number];

/** 生产直连中央 request；替身只在此页私有 runtime 边界。 */
export function createSettingsApi(send: RequestLayer["request"]) {
  return {
    me: () => send<Me>("/m/me"),
    update: (data: Body<"m.me.update">, idempotencyKey: string) =>
      send<Data<"m.me.update">>("/m/me", { method: "PATCH", data, idempotencyKey }),
    sms: (idempotencyKey: string) =>
      send<Data<"m.smsCode.create">>("/m/sms-codes", {
        method: "POST",
        data: { purpose: "phone_change" } satisfies Body<"m.smsCode.create">,
        idempotencyKey,
      }),
    changePhone: (data: Body<"m.me.changePhone">, idempotencyKey: string) =>
      send<Data<"m.me.changePhone">>("/m/me/change-phone", {
        method: "POST",
        data,
        idempotencyKey,
      }),
    identities: (cursor: string | null) =>
      send<Data<"m.me.wechatIdentity.list">>(
        `/m/me/wechat-identities?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    remove: (id: string, idempotencyKey: string) =>
      send<Data<"m.me.wechatIdentity.delete">>(
        `/m/me/wechat-identities/${encodeURIComponent(id)}`,
        { method: "DELETE", idempotencyKey },
      ),
    acknowledge: (id: string, idempotencyKey: string) =>
      send<Data<"m.me.userNotice.acknowledge">>(
        `/m/me/user-notices/${encodeURIComponent(id)}/acknowledge`,
        { method: "POST", idempotencyKey },
      ),
    deletion: (idempotencyKey: string) =>
      send<Data<"m.me.deletion.create">>("/m/me/deletion", {
        method: "POST",
        data: { hasConfirmed: true } satisfies Body<"m.me.deletion.create">,
        idempotencyKey,
      }),
    agreements: (cursor: string | null) =>
      send<Data<"m.agreement.list">>(
        `/m/agreements?scene=login&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { auth: false },
      ),
  };
}
export type SettingsApi = ReturnType<typeof createSettingsApi>;
