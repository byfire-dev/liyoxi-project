import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { createPortalRoutes } from "../../lib/routes";
import { PreviewPage } from "./PreviewPage";
import { createPreviewRoutes } from "./routes";
import { AD_ID } from "./test-helpers";

describe("W6-12 Q9页面排除", () => {
  it("sample分支只给小程序说明，无播放器/确认/下载/任何本叶API", () => {
    const send = vi.fn<typeof fetch>();
    const runtime = createPortalRuntime({ fetch: send });
    const html = renderToStaticMarkup(<PreviewPage runtime={runtime} kind="sample" id={AD_ID} />);
    expect(html).toContain("样片请在小程序查看并确认");
    expect(html).not.toMatch(/<video|<iframe|<button|<img|href=/);
    expect(send).not.toHaveBeenCalled();
    const match = createPortalRoutes(createPreviewRoutes(runtime)).match(
      `/preview/sample/${AD_ID}`,
    );
    expect(match?.route.access).toBe("session");
    runtime.dispose();
  });
  it("未知kind/非法id不产生播放或资源请求", () => {
    const send = vi.fn<typeof fetch>(),
      runtime = createPortalRuntime({ fetch: send });
    for (const [kind, id] of [
      ["other", AD_ID],
      ["ad", "invalid"],
    ]) {
      const html = renderToStaticMarkup(<PreviewPage runtime={runtime} kind={kind!} id={id!} />);
      expect(html).toContain("暂时无法查看此内容");
      expect(html).not.toContain("<video");
    }
    expect(send).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
