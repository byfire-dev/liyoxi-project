import { Alert, Button, Input, Modal, Radio } from "antd";
import type { ReactNode } from "react";
import { FormField } from "./FormField";
import "./ReviewPrimitives.css";

export interface RejectDialogProps {
  title: string;
  context: ReactNode;
  reasons: readonly { value: string; label: string }[];
  reason: string;
  note: string;
  notePlaceholder: string;
  noteMaxLength: number;
  onReasonChange: (reason: string) => void;
  onNoteChange: (note: string) => void;
  children?: ReactNode;
  pending: boolean;
  canSubmit: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: () => void;
}

/** 受控驳回弹层；请求结构与业务校验留在调用方。 */
export function RejectDialog(props: RejectDialogProps) {
  const { pending, onCancel } = props;
  return (
    <Modal
      open
      title={props.title}
      footer={null}
      onCancel={onCancel}
      closable={!pending}
      mask={{ closable: !pending }}
      width={540}
    >
      <div className="lyx-review-reject">
        <p>{props.context}</p>
        <Radio.Group
          aria-label="驳回原因"
          value={props.reason}
          disabled={pending}
          onChange={(event) => props.onReasonChange(String(event.target.value))}
          options={[...props.reasons]}
        />
        <FormField label="驳回说明" value={props.note} maxLength={props.noteMaxLength}>
          {(field) => (
            <Input.TextArea
              {...field}
              value={props.note}
              maxLength={props.noteMaxLength}
              rows={3}
              placeholder={props.notePlaceholder}
              disabled={pending}
              onChange={(event) => props.onNoteChange(event.target.value)}
            />
          )}
        </FormField>
        {props.children}
        {props.error ? <Alert type="error" title={props.error} /> : null}
        <div className="lyx-review-reject__footer">
          <Button disabled={pending} onClick={onCancel}>
            取消
          </Button>
          <Button
            type="primary"
            danger
            disabled={!props.canSubmit || pending}
            loading={pending}
            onClick={() => {
              if (props.canSubmit && !pending) props.onSubmit();
            }}
          >
            确认驳回
          </Button>
        </div>
      </div>
    </Modal>
  );
}
