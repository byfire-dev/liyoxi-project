import { describe, expect, it, vi } from "vitest";
// @ts-expect-error 构建脚本由 Node 直接执行，不引入小程序运行时。
import { probeTrialApi, trialConfigErrors } from "./trial-config.mjs";

const valid = { WEAPP_APPID: "wx1234567890abcdef", WEAPP_API_BASE_URL: "https://api.merchant.cn" };
describe("体验版准备检查", () => {
  it("正式域名和 AppID 可通过，默认缺配置不可通过", () => {
    expect(trialConfigErrors(valid)).toEqual([]);
    expect(trialConfigErrors({})).toHaveLength(2);
    expect(trialConfigErrors({ ...valid, WEAPP_APPID: "touristappid" })).toHaveLength(1);
    expect(trialConfigErrors({ ...valid, WEAPP_GALLERY: "1" })).toHaveLength(1);
  });
  it.each([
    "http://api.merchant.cn",
    "https://api-stg.invalid",
    "https://api.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://api.merchant.cn/api/v1",
    "https://user:password@api.merchant.cn",
    "https://api.merchant.cn?token=secret",
    "https://api.merchant.cn#key",
  ])("拒绝错误配置且不回显输入：%s", (url) => {
    const errors = trialConfigErrors({ ...valid, WEAPP_API_BASE_URL: url });
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain(url);
  });
  it("只读引导和有效协议，不登录或创建账号", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { serverTime: "now" } }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            items: [{ agreementKey: "privacy", currentVersion: { agreementVersionId: "version" } }],
            hasMore: false,
          },
        }),
      });
    expect(await probeTrialApi(valid.WEAPP_API_BASE_URL, fetcher)).toEqual([
      { name: "引导接口", ok: true },
      { name: "登录协议", ok: true },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toMatch(/\/api\/v1\/m\/(bootstrap|agreements)/);
      expect(options.redirect).toBe("error");
      expect(options.headers.Authorization).toBeUndefined();
      expect(options.method).toBeUndefined();
    }
    await probeTrialApi(valid.WEAPP_API_BASE_URL, fetcher, "2.0.0");
    expect(fetcher.mock.calls.at(-1)![1].headers["X-Client-Version"]).toBe("2.0.0");
  });
  it.each([[], [{ agreementKey: "privacy", currentVersion: null }]])(
    "空协议或没有生效版本不算可登录：%j",
    async (items) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ data: { items } }) });
      expect((await probeTrialApi(valid.WEAPP_API_BASE_URL, fetcher))[1].ok).toBe(false);
    },
  );
  it("网络失败和非 JSON 响应只报告失败，不泄漏响应", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(Error("private-detail"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw Error("private-body");
        },
      });
    const result = await probeTrialApi(valid.WEAPP_API_BASE_URL, fetcher);
    expect(result.every((item: { ok: boolean }) => !item.ok)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("像前端一样忽略尚无生效版本的协议", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          items: [
            { agreementKey: "privacy", currentVersion: { agreementVersionId: "active" } },
            { agreementKey: "future", currentVersion: null },
          ],
          hasMore: false,
        },
      }),
    });
    expect((await probeTrialApi(valid.WEAPP_API_BASE_URL, fetcher))[1].ok).toBe(true);
  });
});
