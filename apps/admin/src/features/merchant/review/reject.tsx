import { Checkbox } from "antd";
import { useState } from "react";
import { RejectDialog as SharedRejectDialog } from "../../../components/RejectDialog";
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
    <SharedRejectDialog
      title="驳回资质审核"
      context={`${detail.store.name} · 第 ${detail.roundNo} 轮，商家补正后可重新提交`}
      reasons={reasons
        .filter((item) => item.isEnabled)
        .map((item) => ({ value: item.code, label: item.name }))}
      reason={reason}
      note={note}
      notePlaceholder="请写明需要商家补正的内容"
      noteMaxLength={200}
      onReasonChange={setReason}
      onNoteChange={setNote}
      pending={pending}
      canSubmit={body !== null}
      error={error}
      onCancel={onCancel}
      onSubmit={() => {
        if (body) onSubmit(body);
      }}
    >
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
    </SharedRejectDialog>
  );
}
