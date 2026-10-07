import { DatePicker, type DatePickerProps } from "antd";
import type { ComponentProps, KeyboardEvent } from "react";
import { useState } from "react";
import { flushSync } from "react-dom";

export type DateRangeFieldProps = ComponentProps<typeof DatePicker.RangePicker>;

/** AntD6 的 RangePicker 会在 Tab 上确认并重新聚焦同一字段。
 * 仅隔离输入框的 Tab 冒泡，原生顺序遍历保持有效；日期选择/输入仍交原控件。 */
export function DateRangeField({ open, onOpenChange, onKeyDown, ...props }: DateRangeFieldProps) {
  const [localOpen, setLocalOpen] = useState(props.defaultOpen ?? false);
  const changeOpen: NonNullable<DatePickerProps["onOpenChange"]> = (next) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  function tab(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Tab" || !(event.target instanceof HTMLInputElement)) return;
    // 非空字段保留原始 Tab 确认/校验（包含手输日期与 needConfirm）。
    if (event.target.value) return;
    // 在 RangePicker 内部的确认/重新聚焦处理器之前消费事件，不 preventDefault。
    event.stopPropagation();
    onKeyDown?.(event, () => event.preventDefault());
    if (event.defaultPrevented) return;
    // 空字段可能在已关闭的浮层里仍持有旧焦点锁。同步结束一轮空交互，
    // 两次提交发生在同一键盘事件内，不产生可见的浮层闪烁。
    // 已输入的日期继续由原控件在切换字段/失焦时校验提交，不提前关闭丢弃草稿。
    flushSync(() => changeOpen(true));
    flushSync(() => changeOpen(false));
  }
  return (
    <span onKeyDownCapture={tab} style={{ display: "inline-flex", maxWidth: "100%" }}>
      <DatePicker.RangePicker
        {...props}
        open={open ?? localOpen}
        onOpenChange={changeOpen}
        onKeyDown={onKeyDown}
      />
    </span>
  );
}
