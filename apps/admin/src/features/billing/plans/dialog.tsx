import { Alert, Button, ConfigProvider, Modal } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { billingConflict, billingError } from "./api";
import type { createBillingIntent } from "./model";
import "./billing.css";
/** 仅本工作包表单壳；不修改冻结公共确认/配置构件。 */
export function BillingDialog({
  title,
  intent,
  children,
  submit,
  onClose,
  disabled = false,
  submitText = "保存",
}: {
  title: string;
  intent: ReturnType<typeof createBillingIntent>;
  children: ReactNode;
  submit(): Promise<void>;
  onClose(): void;
  disabled?: boolean;
  submitText?: string;
}) {
  const busy = useRef(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [conflict, setConflict] = useState(false);
  useEffect(() => {
    intent.activate();
    return () => intent.close();
  }, [intent]);
  const close = () => {
    if (!busy.current && !intent.pending) onClose();
  };
  async function save() {
    if (busy.current || intent.pending || disabled || conflict) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await submit();
    } catch (cause) {
      if (!intent.signal.aborted) {
        setError(billingError(cause));
        setConflict(billingConflict(cause));
      }
    } finally {
      busy.current = false;
      if (!intent.signal.aborted) setPending(false);
    }
  }
  return (
    <Modal
      open
      title={title}
      width={640}
      footer={null}
      mask={{ closable: !pending }}
      keyboard={!pending}
      closable={!pending}
      onCancel={close}
    >
      <ConfigProvider componentDisabled={pending}>
        <div className="billing-fields">{children}</div>
      </ConfigProvider>
      {error ? <Alert role="alert" type="error" title={error} /> : null}
      {conflict ? (
        <Alert
          type="warning"
          title="当前事实已经变化，草稿仍保留。请关闭后重新读取并核对，不能用新版本自动覆盖。"
        />
      ) : null}
      <div className="lyx-confirm__footer">
        <Button size="large" disabled={pending} onClick={close}>
          取消
        </Button>
        <Button
          size="large"
          type="primary"
          aria-label={submitText}
          loading={pending}
          disabled={disabled || conflict}
          onClick={() => void save()}
        >
          {submitText}
        </Button>
      </div>
    </Modal>
  );
}
