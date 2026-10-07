import { Button, Select, Space } from "antd";
import { useMemo, useState } from "react";

import { Chart, type ChartOption } from "../components/Chart";
import { PageHeader } from "../components/PageHeader";
import { DEV_FIXTURE_MARK } from "./mark";

export function ChartSample() {
  const [kind, setKind] = useState<"bar" | "line" | "pie">("bar");
  const [state, setState] = useState<"ready" | "empty" | "error">("ready");
  const [hidden, setHidden] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [mounted, setMounted] = useState(true);
  const option: ChartOption = useMemo(
    () => ({
      animation: false,
      tooltip: {},
      ...(kind === "pie"
        ? {
            series: [
              {
                type: "pie",
                radius: "60%",
                data: [
                  { name: "甲组", value: 4 },
                  { name: "乙组", value: 7 },
                  { name: "丙组", value: 2 },
                ],
              },
            ],
          }
        : {
            grid: { left: 40, right: 24, bottom: 40 },
            xAxis: { type: "category", data: ["甲组", "乙组", "丙组"] },
            yAxis: { type: "value" },
            series: [{ type: kind, data: [4, 7, 2] }],
          }),
    }),
    [kind],
  );
  return (
    <div data-fixture={DEV_FIXTURE_MARK} style={{ display: "contents" }}>
      <PageHeader
        title="图表样例"
        subtitle="柱、折线与饼图；固定夹具计数，供容器尺寸与生命周期验收。"
      />
      <Space wrap>
        <Select
          aria-label="图表类型"
          value={kind}
          onChange={setKind}
          options={[
            { value: "bar", label: "柱图" },
            { value: "line", label: "折线图" },
            { value: "pie", label: "饼图" },
          ]}
        />
        <Button onClick={() => setHidden((value) => !value)}>切换隐藏</Button>
        <Button onClick={() => setNarrow((value) => !value)}>切换宽度</Button>
        <Button onClick={() => setMounted((value) => !value)}>切换挂载</Button>
        <Button onClick={() => setState("empty")}>空数据</Button>
        <Button onClick={() => setState("error")}>加载错误</Button>
        <Button onClick={() => setState("ready")}>正常图表</Button>
      </Space>
      <section
        className="lyx-card"
        aria-label="图表容器"
        style={{
          padding: "var(--lyx-space-20)",
          width: narrow ? 420 : "100%",
          display: hidden ? "none" : undefined,
        }}
      >
        {mounted ? (
          <Chart
            label="样例各组计数：甲组4，乙组7，丙组2"
            option={option}
            state={state}
            error="样例图表加载失败"
            onRetry={() => setState("ready")}
          />
        ) : (
          <p>图表已卸载</p>
        )}
      </section>
    </div>
  );
}
