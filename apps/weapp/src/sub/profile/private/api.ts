import type { operations } from "@liyoxi/contract/types/merchant";
import type { RequestLayer } from "../../../lib/request";
export type Data<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { "application/json": { data: infer T } } } };
}
  ? T
  : never;
export type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export type Overview = Data<"m.storeProfile.get">;
export type Basic = Data<"m.storeProfile.basic.get">;
export type Media = Data<"m.storeProfile.media.get">;
export type Service = Data<"m.storeProfile.service.get">;
export type Qualification = Data<"m.storeProfile.qualification.get">;
export type OwnerQualification = Extract<Qualification, { viewerRole: "owner" }>;
export type Doc = NonNullable<OwnerQualification["openRound"]>["docs"][number];
export type DictItems = Data<"m.dictItem.list">["items"][number]["items"];
export function createProfileApi(call: RequestLayer["request"], context: () => string = () => "") {
  const write = <K extends keyof operations>(
    path: string,
    data: Body<K>,
    key: string,
    method: "POST" | "PATCH" = "PATCH",
  ) => call<Data<K>>(path, { method, data, idempotencyKey: key });
  const saveView = async <T>(path: string, data: unknown, key: string): Promise<T> => {
    const current = context();
    const result = await call<T & { replayed: boolean }>(path, {
      method: "PATCH",
      data,
      idempotencyKey: key,
    });
    if (!result.replayed) return result;
    if (current !== context()) throw new Error("门店或登录状态已变化，请重新进入");
    return call<T>(path);
  };
  return {
    overview: () => call<Overview>("/m/store-profile"),
    basic: () => call<Basic>("/m/store-profile/basic"),
    media: () => call<Media>("/m/store-profile/media"),
    service: () => call<Service>("/m/store-profile/service"),
    qualification: () => call<Qualification>("/m/store-profile/qualification"),
    create: (key: string) => write<"m.entity.create">("/m/entities", {}, key, "POST"),
    saveBasic: (body: Body<"m.storeProfile.basic.update">, key: string) =>
      saveView<Basic>("/m/store-profile/basic", body, key),
    saveMedia: (body: Body<"m.storeProfile.media.update">, key: string) =>
      saveView<Media>("/m/store-profile/media", body, key),
    saveService: (body: Body<"m.storeProfile.service.update">, key: string) =>
      saveView<Service>("/m/store-profile/service", body, key),
    saveQualification: (body: Body<"m.storeProfile.qualification.update">, key: string) =>
      write<"m.storeProfile.qualification.update">("/m/store-profile/qualification", body, key),
    saveContact: (body: Body<"m.storeProfile.contact.update">, key: string) =>
      write<"m.storeProfile.contact.update">("/m/store-profile/contact", body, key),
    createDoc: (body: Body<"m.qualificationDoc.create">, key: string) =>
      write<"m.qualificationDoc.create">("/m/qualification-docs", body, key, "POST"),
    saveDoc: (id: string, body: Body<"m.qualificationDoc.update">, key: string) =>
      write<"m.qualificationDoc.update">(
        `/m/qualification-docs/${encodeURIComponent(id)}`,
        body,
        key,
      ),
    submit: (body: Body<"m.storeProfile.qualification.submit">, key: string) =>
      write<"m.storeProfile.qualification.submit">(
        "/m/store-profile/qualification/submit",
        body,
        key,
        "POST",
      ),
    dict: async (typeKey: string, parentCode?: string) =>
      (
        await call<Data<"m.dictItem.list">>(
          `/m/dict-items?typeKey=${encodeURIComponent(typeKey)}&includeDisabled=true${parentCode ? `&parentCode=${encodeURIComponent(parentCode)}` : ""}`,
        )
      ).items,
  };
}
export type ProfileApi = ReturnType<typeof createProfileApi>;
