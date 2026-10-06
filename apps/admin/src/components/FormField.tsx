import { useId, type ReactNode } from "react";

/** 单字段：标签、字数上限与就地错误。调用方把 id/错误关联传到真实控件。 */
export function FormField({
  label,
  value,
  maxLength,
  error,
  children,
}: {
  label: string;
  value?: string;
  maxLength?: number;
  error?: string;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid": boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="lyx-auth-field">
      <div className="lyx-auth-field__label">
        <label htmlFor={id}>{label}</label>
        {maxLength !== undefined ? (
          <span>
            {value?.length ?? 0}/{maxLength}
          </span>
        ) : null}
      </div>
      {children({
        id,
        "aria-describedby": error ? errorId : undefined,
        "aria-invalid": Boolean(error),
      })}
      {error ? (
        <div id={errorId} role="alert" className="lyx-auth-field__error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
