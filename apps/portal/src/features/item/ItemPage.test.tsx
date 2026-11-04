import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ItemContent } from "./ItemPage";
import type { ItemSnapshot } from "./model";
import { PUBLISH_LIST, RELEASE } from "./test-helpers";

const actions = {
  load: vi.fn(),
  episode: vi.fn(),
  zip: vi.fn(),
  cancelZip: vi.fn(),
  publishText: vi.fn(),
};
const state: ItemSnapshot = {
  release: RELEASE,
  publishList: PUBLISH_LIST,
  loading: false,
  error: "",
  actionError: "",
  textError: "",
  notice: "",
  episode: null,
  textBusy: false,
  zip: "idle",
};
it("详情保留manifest、变更集及清单，但不把签发记录说成下载完成", () => {
  const html = renderToStaticMarkup(<ItemContent state={state} actions={actions} />);
  expect(html).toContain("第1集.mp4");
  expect(html).toContain("本次更新");
  expect(html).toContain("复制发布清单");
  expect(html).toContain("下载清单文本");
  expect(html).toContain("下载整包 ZIP");
  expect(html).not.toMatch(/下载完成|保存成功|支付|购买|套餐/);
});
it.each([
  ["building", "停止等待"],
  ["failed", "重新打包下载"],
  ["timeout", "已停止查询"],
] as const)("ZIP %s给出真实下一步且逐集入口仍可用", (zip, text) => {
  const html = renderToStaticMarkup(<ItemContent state={{ ...state, zip }} actions={actions} />);
  expect(html).toContain(text);
  expect(html).toContain("下载第 1 集");
});
it("授权过期显示服务端阻断原因并禁用下载", () => {
  const html = renderToStaticMarkup(
    <ItemContent
      state={{
        ...state,
        release: {
          ...RELEASE,
          isDownloadable: false,
          downloadBlocker: { kind: "grant_invalid", reason: "expired" },
        },
      }}
      actions={actions}
    />,
  );
  expect(html).toContain("下载授权已到期");
  expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(4);
});
