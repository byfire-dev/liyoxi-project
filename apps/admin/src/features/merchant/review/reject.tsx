import { Alert, Button, Checkbox, Input, Modal, Radio } from "antd";
import { useState } from "react";
import { FormField } from "../../../components/FormField";
import type { Detail, Reason, RejectBody } from "./model";
import { rejectBody } from "./model";

export function RejectDialog({
  detail,
  reasons,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  detail: Detail;
  reasons: readonly Reason[];
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (body: RejectBody) => void;
}) {
  const [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [docs, setDocs] = useState<string[]>([]);
  const body = rejectBody(detail, reason, note, docs);
  return (
    <Modal
      open
      title="驳回资质审核"
      footer={null}
      onCancel={onCancel}
      closable={!pending}
      mask={{ closable: !pending }}
      width={540}
    >
      <div className="lyx-review-reject">
        <p>
          {detail.store.name} · 第 {detail.roundNo} 轮，商家补正后可重新提交
        </p>
        <Radio.Group
          aria-label="驳回原因"
          value={reason}
          onChange={(event) => setReason(String(event.target.value))}
          disabled={pending}
          options={reasons
            .filter((item) => item.isEnabled)
            .map((item) => ({ value: item.code, label: item.name }))}
        />
        <FormField label="驳回说明" value={note} maxLength={200}>
          {(props) => (
            <Input.TextArea
              {...props}
              value={note}
              maxLength={200}
              rows={3}
              placeholder="请写明需要商家补正的内容"
              disabled={pending}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </FormField>
        <div>
          <p>需要补传的证照（可选）</p>
          <Checkbox.Group
            value={docs}
            disabled={pending}
            onChange={(value) => setDocs(value.map(String))}
            options={detail.docs.map((doc) => ({
              value: doc.qualificationDocId,
              label: doc.permitType?.name ?? "营业执照",
            }))}
          />
        </div>
        {error ? <Alert type="error" title={error} /> : null}
        <div className="lyx-review-reject__footer">
          <Button disabled={pending} onClick={onCancel}>
            取消
          </Button>
          <Button
            type="primary"
            danger
            disabled={!body || pending}
            loading={pending}
            onClick={() => {
              if (body) onSubmit(body);
            }}
          >
            确认驳回
          </Button>
        </div>
      </div>
    </Modal>
  );
}
