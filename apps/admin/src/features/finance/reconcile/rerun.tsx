import type { ReconDayRow } from "@liyoxi/contract";
import { Alert, Button, Checkbox, Modal, Space } from "antd";
import { useState } from "react";
import type { ReconcileApi } from "./api";
import { dayStatus } from "./labels";
import { useReconcileMutation } from "./mutation";
import type { RerunTarget } from "./types";

export function RerunDay({
  value,
  api,
  refresh,
  onDone,
  onClose,
}: {
  value: RerunTarget;
  api: ReconcileApi;
  refresh: (signal: AbortSignal) => Promise<void>;
  onDone: (value: ReconDayRow) => void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState(false),
    mutation = useReconcileMutation<RerunTarget, ReconDayRow>({
      command: "rerun",
      execute: (target, key, signal) => api.rerun(target, key, signal),
      refresh,
      onDone,
      invalidate: () => setChecked(false),
    }),
    disabled = mutation.busy || mutation.blocked || mutation.readOnly;
  return (
    <Modal
      open
      title={`重新对账 ${value.billDate}`}
      footer={null}
      closable={!mutation.busy}
      keyboard={!mutation.busy}
      mask={{ closable: !mutation.busy }}
      onCancel={onClose}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Alert
          type="info"
          title={`当前${dayStatus[value.status]}，已运行 ${value.runCount} 次。重跑后读取服务端实际结果。`}
        />
        {mutation.notice ? <Alert type="warning" title={mutation.notice} /> : null}
        <Checkbox
          disabled={disabled}
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        >
          确认重新核对账单日 {value.billDate}
        </Checkbox>
        <Space>
          <Button
            type="primary"
            loading={mutation.busy}
            disabled={disabled || !checked}
            onClick={() => {
              if (checked) void mutation.submit(value);
            }}
          >
            确认重跑
          </Button>
          {mutation.blocked || mutation.readOnly ? (
            <Button disabled={mutation.busy} onClick={() => void mutation.reread()}>
              重新读取
            </Button>
          ) : null}
          <Button disabled={mutation.busy} onClick={onClose}>
            关闭
          </Button>
        </Space>
      </Space>
    </Modal>
  );
}
