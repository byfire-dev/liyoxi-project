import { useId, type ReactNode } from "react";

import "./W202Controls.css";

export interface SingleSelectOption {
  value: string;
  /** 文本或展示内容；不要在选项标签里嵌入另一个交互控件。 */
  label: ReactNode;
  disabled?: boolean;
}

export interface CapsuleRadioProps {
  ariaLabel: string;
  options: readonly SingleSelectOption[];
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  name?: string;
  /** 原因胶囊通过同一原生单选组提供键盘与受控行为。 */
  appearance?: "filter" | "reason";
}

export function CapsuleRadio({
  ariaLabel,
  options,
  value,
  onChange,
  disabled = false,
  name,
  appearance = "filter",
}: CapsuleRadioProps) {
  const id = useId();
  return (
    <fieldset
      className={`lyx-capsule-radio lyx-capsule-radio--${appearance}`}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      {options.map((option) => (
        <label className="lyx-capsule-radio__option" key={option.value}>
          <input
            className="lyx-w202-radio-input"
            type="radio"
            name={name ?? `lyx-capsule-${id}`}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => {
              if (!disabled && !option.disabled) onChange(option.value);
            }}
          />
          <span className="lyx-capsule-radio__body">
            {appearance === "reason" ? (
              <span className="lyx-w202-radio-dot" aria-hidden="true" />
            ) : null}
            {option.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
