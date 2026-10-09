import { describe, expect, it } from "vitest";
import { createRequestLayer } from "@/lib/request";
import type { WireRequest } from "@/lib/platform";
import { createMessagesApi } from "./api";

describe("消息中央请求接线", () => {
  it("五接口按真实 method/body/key/context 发出，无店不带门店头，cursor 不解析", async () => {
    const sent: WireRequest[] = [];
    let storeId: string | null = null;
    const layer = createRequestLayer({
      baseUrl: "https://api.example.test",
      send: async (request) => {
        sent.push(request);
        return { statusCode: 200, header: {}, data: { code: 0, message: "ok", data: null } };
      },
      clock: { now: () => 0, sleep: async () => {} },
      uuid: () => "fake-uuid",
      client: () => ({ platform: "ios", version: "1.0.0", envVersion: "trial" }),
      getToken: () => "fictional-session",
      getStoreId: () => storeId,
    });
    const api = createMessagesApi(layer.request);
    await api.list("all", "opaque+/=");
    await api.summary();
    await api.settings();
    expect(sent[0]?.url).toBe(
      "https://api.example.test/api/v1/m/messages?tab=all&limit=20&cursor=opaque%2B%2F%3D",
    );
    expect(sent[0]?.header["X-Store-Id"]).toBeUndefined();
    storeId = "fictional-store";
    await api.read("message/id", "message_read:key");
    await api.batchRead({ tab: "delivery", upToMessageId: "boundary" }, "messages_read:key");
    expect(sent.map((request) => request.method)).toEqual(["GET", "GET", "GET", "POST", "POST"]);
    expect(sent[3]?.url).toBe("https://api.example.test/api/v1/m/messages/message%2Fid/read");
    expect(sent[3]?.header["X-Store-Id"]).toBe(storeId);
    expect(sent[3]?.header["Idempotency-Key"]).toBe("message_read:key");
    expect(sent[4]?.data).toEqual({ tab: "delivery", upToMessageId: "boundary" });
    expect(sent[4]?.header["Idempotency-Key"]).toBe("messages_read:key");
    await api.agreement("user");
    expect(sent[5]?.url).toContain("/m/agreements?agreementKey=user&limit=1");
  });
});
