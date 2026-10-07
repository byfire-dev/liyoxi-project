import {
  BarChart,
  LineChart,
  PieChart,
  type BarSeriesOption,
  type LineSeriesOption,
  type PieSeriesOption,
} from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import { init, use as registerCharts, type ComposeOption } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

import { createChartController } from "./chart-lifecycle";
import { EmptyState, ErrorState } from "./StateBlock";

registerCharts([
  BarChart,
  LineChart,
  PieChart,
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);
export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
>;
export interface ChartProps {
  label: string;
  option: ChartOption;
  height?: number;
  state?: "ready" | "empty" | "error";
  error?: string;
  onRetry?: () => void;
}

export function Chart({
  label,
  option,
  height = 280,
  state = "ready",
  error,
  onRetry,
}: ChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(option);
  const controller = useRef<ReturnType<typeof createChartController<ChartOption>> | undefined>(
    undefined,
  );
  useEffect(() => {
    latest.current = option;
    controller.current?.update(option);
  }, [option]);
  useEffect(() => {
    const element = container.current;
    if (!element || state !== "ready") return;
    const styles = getComputedStyle(element);
    const token = (name: string) => styles.getPropertyValue(`--lyx-color-${name}`).trim();
    const theme = {
      color: [token("primary"), token("info"), token("success"), token("purple")],
      textStyle: { color: token("text-secondary"), fontFamily: styles.fontFamily },
      categoryAxis: { axisLine: { lineStyle: { color: token("border-strong") } } },
      valueAxis: { splitLine: { lineStyle: { color: token("border-light") } } },
    };
    const binding = createChartController(element, latest.current, {
      init: () => {
        const chart = init(element, theme, { renderer: "canvas" });
        return {
          setOption: (next) => chart.setOption(next, { notMerge: true }),
          resize: () => chart.resize(),
          dispose: () => chart.dispose(),
        };
      },
      observe: (resize) => {
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        return () => observer.disconnect();
      },
    });
    controller.current = binding;
    return () => {
      binding.dispose();
      controller.current = undefined;
    };
  }, [state, label]);
  if (state === "empty") return <EmptyState title="暂无图表数据" />;
  if (state === "error")
    return onRetry ? (
      <ErrorState message={error} onRetry={onRetry} />
    ) : (
      <div role="alert">{error ?? "图表没有加载成功"}</div>
    );
  return (
    <div
      ref={container}
      role="img"
      aria-label={label}
      style={{ height, width: "100%", minWidth: 0 }}
    />
  );
}
