import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { RejectDialog, type RejectDialogProps } from "./RejectDialog";

const base: RejectDialogProps = {
  title: "驳回核验",
  context: "请说明驳回原因",
  reasons: [{ value: "unclear", label: "内容不清晰" }],
  reason: "unclear",
  note: "请补充清晰材料",
  notePlaceholder: "说明",
  noteMaxLength: 200,
  onReasonChange: () => {},
  onNoteChange: () => {},
  pending: false,
  canSubmit: true,
  onCancel: () => {},
  onSubmit: () => {},
};

// Node 单测不能挂载 Modal 的 portal；调用它收到的取消入口覆盖 Esc 的同一回调路径。
function controls(props: RejectDialogProps) {
  const modal = RejectDialog(props);
  const panel = modal.props.children as ReactElement<{
    children: ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>[];
  }>;
  const footer = panel.props.children.at(-1)!;
  return { modal: modal.props, cancel: footer.props.children[0]!.props.onClick };
}

describe("公共驳回弹层的取消入口", () => {
  it("提交中：Esc、遮罩、关闭按钮和取消入口均不能取消", () => {
    const onCancel = vi.fn();
    const { modal, cancel } = controls({ ...base, pending: true, onCancel });
    modal.onCancel();
    cancel();
    expect(onCancel).not.toHaveBeenCalled();
    expect(modal.keyboard).toBe(false);
    expect(modal.closable).toBe(false);
    expect(modal.mask).toEqual({ closable: false });
  });

  it("非提交时：保留 Esc 和取消按钮的关闭行为", () => {
    const onCancel = vi.fn();
    const { modal, cancel } = controls({ ...base, onCancel });
    expect(modal.keyboard).not.toBe(false);
    modal.onCancel();
    cancel();
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
