import { Input } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfigPage } from "./ConfigPage";
import { MasterDetailPage } from "./MasterDetailPage";

describe("主从/配置公共骨架", () => {
  it("选中B时不得渲染已返回的A详情；取消选中显示明确空态", () => {
    const props = { label: "组", list: () => "list", onSelect: () => {}, onRetry: () => {} };
    const stale = renderToStaticMarkup(
      <MasterDetailPage
        {...props}
        selectedKey="b"
        detail={{ key: "a", status: "ready", content: "A-private-detail" }}
      />,
    );
    expect(stale).not.toContain("A-private-detail");
    expect(stale).toContain('aria-busy="true"');
    const empty = renderToStaticMarkup(<MasterDetailPage {...props} />);
    expect(empty).toContain("请选择一条记录");
  });
  it("配置只读禁用原生/AntD字段、隐藏保存动作；pending仍可读且禁用", () => {
    const view = (readOnly: boolean, pending: boolean) =>
      renderToStaticMarkup(
        <ConfigPage label="配置" readOnly={readOnly} pending={pending} onSubmit={() => {}}>
          <Input aria-label="配置名" defaultValue="当前值" />
        </ConfigPage>,
      );
    expect(view(true, false)).toContain("当前配置为只读");
    expect(view(true, false)).not.toContain("保存配置");
    expect(view(false, true)).toContain('aria-busy="true"');
    expect(view(false, true)).toMatch(/<fieldset[^>]*disabled/);
    expect(view(false, true)).toMatch(/<input[^>]*disabled/);
  });
});
