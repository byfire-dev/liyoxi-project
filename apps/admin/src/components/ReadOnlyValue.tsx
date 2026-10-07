import type { ReactNode } from "react";

import "./W202Controls.css";

export interface ReadOnlyValueProps {
  label: string;
  value: ReactNode;
  reason?: ReactNode;
}

/** 只读文字块；调用方提供已经允许展示的值和只读原因。 */
export function ReadOnlyValue({ label, value, reason }: ReadOnlyValueProps) {
  return (
    <div className="lyx-readonly-field" role="group" aria-label={label}>
      <div className="lyx-readonly-field__label">{label}</div>
      <div className="lyx-readonly-field__value">{value}</div>
      {reason != null ? <div className="lyx-readonly-field__reason">{reason}</div> : null}
    </div>
  );
}
