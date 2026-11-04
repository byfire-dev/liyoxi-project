import { expect, it } from "vitest";
import { packStatus } from "./pack-panel";
import type { PackResult } from "./publish-api";
it("按DTO显示四态且附代次；failed仅契约消费测试，不当作生产可观察证据", () => {
  for (const [zipState, type, label] of [
    ["none", "info", "尚未打包"],
    ["building", "info", "正在打包"],
    ["failed", "error", "打包失败"],
    ["ready", "success", "打包完成"],
  ] as const) {
    expect(packStatus({ zipState, zipGen: 3 } as PackResult)).toEqual({
      type,
      title: `${label} · 第 3 次打包`,
    });
  }
});
