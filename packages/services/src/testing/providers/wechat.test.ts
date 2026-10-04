import { describe, expect, it } from "vitest";

import { createFakeMedia } from "./media.js";
import { createFakeWechat } from "./wechat.js";

// 内容安全替身的用例（W0-19 任务书 第 7 节第 8 条；计划 第 7.3 节表后的留桩清单）：
// 文本检测可切到“服务不可用”分支；图片与视频审核替身直接放行。

const TEXT = { openid: "openid-1", scene: "profile", content: "店里的称呼" } as const;
const IMAGE = {
  openid: "openid-1",
  scene: "profile",
  mediaUrl: "https://example.invalid/a.jpg",
} as const;

describe("文本检测", () => {
  it("缺省放行", async () => {
    const wechat = createFakeWechat();
    expect(await wechat.checkText(TEXT)).toEqual({
      ok: true,
      value: { verdict: "pass", traceId: "fake-trace-1" },
    });
  });

  it("切到“服务不可用”：之后每次都返回 unavailable，直到切回来", async () => {
    const wechat = createFakeWechat();
    wechat.setTextCheckAvailable(false);
    for (let round = 0; round < 3; round += 1) {
      expect(await wechat.checkText(TEXT)).toEqual({
        ok: false,
        reason: "unavailable",
        message: "文本内容安全服务不可用（替身）",
      });
    }
    wechat.setTextCheckAvailable(true);
    expect(await wechat.checkText(TEXT)).toMatchObject({ ok: true, value: { verdict: "pass" } });
    // 服务不可用的那三次也记了调用：调用方确实去检了，不是跳过
    expect(wechat.callsOf("checkText")).toHaveLength(4);
  });

  it("“服务不可用即拒收”的分支：调用方看到 unavailable 就拒收，不当作放行", async () => {
    const wechat = createFakeWechat();
    /** 调用方的样子：检测没办成即拒收 */
    async function acceptDisplayName(content: string): Promise<"accepted" | "rejected"> {
      const checked = await wechat.checkText({ ...TEXT, content });
      if (!checked.ok) return "rejected";
      return checked.value.verdict === "pass" ? "accepted" : "rejected";
    }
    expect(await acceptDisplayName("张三")).toBe("accepted");
    wechat.setTextCheckAvailable(false);
    expect(await acceptDisplayName("张三")).toBe("rejected");
  });

  it("预置结论：按顺序各用一次，用完了放行", async () => {
    const wechat = createFakeWechat();
    wechat.textVerdicts.push("block", "review");
    const verdicts = [];
    for (let round = 0; round < 3; round += 1) {
      const checked = await wechat.checkText(TEXT);
      verdicts.push(checked.ok ? checked.value.verdict : checked.reason);
    }
    expect(verdicts).toEqual(["block", "review", "pass"]);
  });

  it("服务不可用时不消耗预置结论", async () => {
    const wechat = createFakeWechat();
    wechat.textVerdicts.push("block");
    wechat.setTextCheckAvailable(false);
    await wechat.checkText(TEXT);
    wechat.setTextCheckAvailable(true);
    expect(await wechat.checkText(TEXT)).toMatchObject({ ok: true, value: { verdict: "block" } });
  });
});

describe("图片与视频审核", () => {
  it("图片审核直接放行；文本检测不可用、预置了违规结论都不影响它", async () => {
    const wechat = createFakeWechat();
    wechat.textVerdicts.push("block");
    wechat.setTextCheckAvailable(false);
    for (let round = 0; round < 2; round += 1) {
      expect(await wechat.checkImage(IMAGE)).toMatchObject({
        ok: true,
        value: { verdict: "pass" },
      });
    }
  });

  it("视频审核（media 替身）直接放行", async () => {
    const media = createFakeMedia();
    expect(
      await media.audit({
        src: { bucket: "media", key: "incoming/a.mp4" },
        scenes: ["porn", "politics"],
        userData: "job:1",
      }),
    ).toEqual({ ok: true, value: { verdict: "pass", processed: true } });
  });
});

describe("登录、手机号、订阅消息、小程序码", () => {
  it("登录与手机号：按预置的 code 给；没预置的 code 返回 rejected", async () => {
    const wechat = createFakeWechat();
    wechat.sessions.set("code-boss", { openid: "openid-boss", unionid: "union-boss" });
    wechat.phones.set("phone-code", "13912345678");
    expect(await wechat.code2Session({ code: "code-boss" })).toEqual({
      ok: true,
      value: { openid: "openid-boss", unionid: "union-boss" },
    });
    expect(await wechat.getPhoneNumber({ code: "phone-code" })).toEqual({
      ok: true,
      value: { phone: "13912345678" },
    });
    expect(await wechat.code2Session({ code: "unknown" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(await wechat.getPhoneNumber({ code: "unknown" })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
  });

  it("订阅消息：记下来，不真发；注入失败时不记", async () => {
    const wechat = createFakeWechat();
    const message = {
      openid: "openid-1",
      templateId: "tpl-1",
      page: "pages/order/detail",
      data: { thing1: "已交付" },
    };
    expect(await wechat.sendSubscribeMessage(message)).toEqual({ ok: true, value: undefined });
    wechat.failNext("sendSubscribeMessage", { reason: "rejected", message: "用户拒收" });
    expect(await wechat.sendSubscribeMessage(message)).toEqual({
      ok: false,
      reason: "rejected",
      message: "用户拒收",
    });
    expect(wechat.subscribeMessages).toEqual([message]);
  });

  it("小程序码：内容由 scene 与 page 推出", async () => {
    const wechat = createFakeWechat();
    const code = await wechat.createMiniProgramCode({ scene: "inv=1", page: "pages/invite/index" });
    if (!code.ok) throw new Error(code.message);
    expect(new TextDecoder().decode(code.value.image)).toBe(
      "fake-mini-code:pages/invite/index:inv=1",
    );
    expect(code.value.contentType).toBe("image/png");
  });
});
