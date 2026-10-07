import { Button, ConfigProvider } from "antd";
import { useRef, useState, type ReactNode } from "react";

import "./W202Pages.css";

export interface ConfigPageProps {
  label: string;
  children: ReactNode;
  aside?: ReactNode;
  readOnly?: boolean;
  pending?: boolean;
  canSubmit?: boolean;
  submitLabel?: string;
  error?: string;
  /** 字段校验、权限、版本与业务幂等均由调用方负责。 */
  onSubmit: () => void | Promise<void>;
  onSubmitError?: (error: unknown) => void;
}

export function ConfigPage({
  label,
  children,
  aside,
  readOnly = false,
  pending = false,
  canSubmit = true,
  submitLabel = "保存配置",
  error,
  onSubmit,
  onSubmitError,
}: ConfigPageProps) {
  const running = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const busy = pending || submitting;
  const disabled = readOnly || busy;
  const message = error ?? localError;
  async function submit() {
    if (disabled || !canSubmit || running.current) return;
    running.current = true;
    setSubmitting(true);
    setLocalError(undefined);
    try {
      await onSubmit();
    } catch (cause) {
      if (onSubmitError) onSubmitError(cause);
      else setLocalError("没有保存成功，请稍后重试");
    } finally {
      running.current = false;
      setSubmitting(false);
    }
  }
  return (
    <div className={`lyx-config-page${aside ? " lyx-config-page--aside" : ""}`}>
      <form
        aria-label={label}
        aria-busy={busy}
        className="lyx-card lyx-config-page__form"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <ConfigProvider componentDisabled={disabled}>
          <fieldset disabled={disabled} className="lyx-config-page__fields">
            <legend className="lyx-visually-hidden">{label}</legend>
            {children}
          </fieldset>
        </ConfigProvider>
        {message ? (
          <div role="alert" className="lyx-config-page__error">
            {message}
          </div>
        ) : null}
        <div className="lyx-config-page__footer">
          {readOnly ? (
            <span>当前配置为只读</span>
          ) : (
            <Button
              type="primary"
              htmlType="button"
              onClick={() => void submit()}
              disabled={!canSubmit || busy}
              loading={busy}
            >
              {submitLabel}
            </Button>
          )}
        </div>
      </form>
      {aside ? (
        <aside className="lyx-card lyx-w202-side" aria-label="配置说明">
          {aside}
        </aside>
      ) : null}
    </div>
  );
}
