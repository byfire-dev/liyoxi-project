import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { createPortalRuntime } from "./lib/runtime";

describe("下载页空壳", () => {
  it("只有一个占位页；不出现价格、套餐与购买入口", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("狸有戏 · 电脑端下载");
    expect(html).toContain("页面建设中");
    expect(html).not.toMatch(/¥|套餐|购买|支付|充值/);
  });

  it("公开叶不因App挂载触发current；壳与runtime可供后继扩叶", () => {
    const send = vi.fn<typeof fetch>();
    const runtime = createPortalRuntime({ fetch: send });
    const html = renderToStaticMarkup(
      <App
        runtime={runtime}
        routes={[{ path: "/", owner: "W6-10", access: "public", render: () => <p>公开叶测试</p> }]}
      />,
    );
    expect(html).toContain("公开叶测试");
    expect(send).not.toHaveBeenCalled();
    runtime.dispose();
    runtime.dispose();
    expect(runtime.session.captureScope()).toBeNull();
  });
});
