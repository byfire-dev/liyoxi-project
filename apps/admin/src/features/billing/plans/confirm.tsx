import { useEffect, useState } from "react";
import { ConfirmAction, type ConfirmSpec } from "../../../components/ConfirmAction";
import { billingConflict, billingError } from "./api";
import { createBillingIntent } from "./model";
/** 同步闩/生命周期只服务本包；实际确认key来自冻结ConfirmAction。 */
export function BillingConfirm({
  action,
  spec,
  submit,
  onClose,
  onSaved,
  onConflict,
}: {
  action: string;
  spec: ConfirmSpec;
  submit(key: string, signal: AbortSignal): Promise<unknown>;
  onClose(): void;
  onSaved(): void;
  onConflict?(): void;
}) {
  const [intent] = useState(() => createBillingIntent(action));
  useEffect(() => {
    intent.activate();
    return () => intent.close();
  }, [intent]);
  return (
    <ConfirmAction
      open
      action={action}
      spec={spec}
      onCancel={onClose}
      onDone={onSaved}
      onConfirm={async ({ idempotencyKey }) => {
        try {
          const result = await intent.submit({ action }, (_key, signal) =>
            submit(idempotencyKey, signal),
          );
          return result === undefined
            ? { outcome: "failed", message: "操作已关闭或正在提交" }
            : { outcome: "done" };
        } catch (cause) {
          if (billingConflict(cause)) {
            onClose();
            onConflict?.();
          }
          return { outcome: "failed", message: billingError(cause) };
        }
      }}
    />
  );
}
