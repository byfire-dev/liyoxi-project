import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { MonthSwitcher, type MonthSwitcherProps } from "./MonthSwitcher";

function arrows(props: MonthSwitcherProps) {
  const children = MonthSwitcher(props).props.children as ReactElement<{
    disabled: boolean;
    onClick: () => void;
  }>[];
  return { previous: children[0]!.props, next: children[2]!.props };
}

describe("受控月份导航", () => {
  it("跨年导航发出正确月份，回写前继续使用原值", () => {
    const onChange = vi.fn();
    const december = arrows({ value: { year: 2026, month: 12 }, onChange });
    december.next.onClick();
    december.next.onClick();
    expect(onChange.mock.calls).toEqual([[{ year: 2027, month: 1 }], [{ year: 2027, month: 1 }]]);
    arrows({ value: { year: 2027, month: 1 }, onChange }).previous.onClick();
    expect(onChange).toHaveBeenLastCalledWith({ year: 2026, month: 12 });
  });

  it("范围边界禁用导航，也拦住直接调用该按钮的事件", () => {
    const onChange = vi.fn();
    const props = {
      value: { year: 2026, month: 10 },
      min: { year: 2026, month: 10 },
      max: { year: 2026, month: 11 },
      onChange,
    };
    const first = arrows(props);
    expect(first.previous.disabled).toBe(true);
    expect(first.next.disabled).toBe(false);
    first.previous.onClick();
    expect(onChange).not.toHaveBeenCalled();
    first.next.onClick();
    expect(onChange).toHaveBeenCalledWith({ year: 2026, month: 11 });

    onChange.mockClear();
    const last = arrows({ ...props, value: { year: 2026, month: 11 } });
    expect(last.next.disabled).toBe(true);
    last.next.onClick();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    { value: { year: 2026, month: 10 }, disabled: true },
    { value: { year: 2026, month: 13 } },
    { value: { year: 2026.5, month: 10 } },
    {
      value: { year: 2026, month: 10 },
      min: { year: 2026, month: 12 },
      max: { year: 2026, month: 9 },
    },
    { value: { year: 2026, month: 10 }, min: { year: 2026, month: 0 } },
  ])("无效范围或禁用状态不产生选择：%j", (props) => {
    const onChange = vi.fn();
    const controls = arrows({ ...props, onChange });
    expect(controls.previous.disabled).toBe(true);
    expect(controls.next.disabled).toBe(true);
    controls.previous.onClick();
    controls.next.onClick();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("不越过受支持的年份范围", () => {
    const onChange = vi.fn();
    const first = arrows({ value: { year: 1, month: 1 }, onChange });
    const last = arrows({ value: { year: 9999, month: 12 }, onChange });
    expect(first.previous.disabled).toBe(true);
    expect(last.next.disabled).toBe(true);
    first.previous.onClick();
    last.next.onClick();
    expect(onChange).not.toHaveBeenCalled();
  });
});
