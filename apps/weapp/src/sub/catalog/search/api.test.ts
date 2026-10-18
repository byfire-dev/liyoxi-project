import { expect, it } from "vitest";
import type { RequestLayer } from "@/lib/request";
import { createSearchApi } from "./api";

it("仅调用真实配置/搜索GET，q和opaque cursor分别编码，固定20；无未登记追踪", async () => {
  const calls: Parameters<RequestLayer["request"]>[] = [];
  const send: RequestLayer["request"] = async <T>(
    ...args: Parameters<RequestLayer["request"]>
  ): Promise<T> => {
    calls.push(args);
    throw new Error("owned_transport_fixture");
  };
  const api = createSearchApi(send);
  await expect(api.config()).rejects.toThrow("owned_transport_fixture");
  await expect(api.search("都市😀", "opaque+/=?&中")).rejects.toThrow("owned_transport_fixture");
  expect(calls).toEqual([
    ["/m/mall-config"],
    [
      `/m/dramas/search?q=${encodeURIComponent("都市😀")}&limit=20&cursor=${encodeURIComponent("opaque+/=?&中")}`,
    ],
  ]);
});
