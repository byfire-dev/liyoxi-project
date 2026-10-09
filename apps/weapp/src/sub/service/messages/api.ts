import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export const MESSAGE_TABS = [
  "all",
  "order",
  "delivery",
  "launch",
  "plan_points",
  "review",
  "store",
  "service",
] as const;
export type MessageTab = (typeof MESSAGE_TABS)[number];
export type Message = Data<"m.message.list">["items"][number];
export type Summary = Data<"m.message.summary">;
export type Settings = Data<"m.notifySetting.list">;

export function createMessagesApi(send: RequestLayer["request"]) {
  return {
    list: (tab: MessageTab, cursor: string | null) =>
      send<Data<"m.message.list">>(
        `/m/messages?tab=${tab}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    summary: () => send<Summary>("/m/messages/summary"),
    settings: () => send<Settings>("/m/notify-settings"),
    agreement: (key: string) =>
      send<Data<"m.agreement.list">>(
        `/m/agreements?agreementKey=${encodeURIComponent(key)}&limit=1`,
        { auth: false },
      ),
    read: (id: string, idempotencyKey: string) =>
      send<Data<"m.message.read">>(`/m/messages/${encodeURIComponent(id)}/read`, {
        method: "POST",
        idempotencyKey,
      }),
    batchRead: (data: Body<"m.message.batchRead">, idempotencyKey: string) =>
      send<Data<"m.message.batchRead">>("/m/messages/read", {
        method: "POST",
        data,
        idempotencyKey,
      }),
  };
}
export type MessagesApi = ReturnType<typeof createMessagesApi>;
