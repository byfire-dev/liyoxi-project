import { useId, type ReactNode } from "react";

import type { CapsuleRadioProps, SingleSelectOption } from "./CapsuleRadio";

import "./W202Controls.css";

export interface RadioCardOption extends SingleSelectOption {
  description?: ReactNode;
  /** 装饰头像；人员名称由 label 提供。 */
  avatar?: ReactNode;
  /** 负载等展示事实由调用方提供。 */
  meta?: ReactNode;
}

export interface RadioCardProps extends Omit<CapsuleRadioProps, "appearance" | "options"> {
  options: readonly RadioCardOption[];
}

export function RadioCard({
  ariaLabel,
  options,
  value,
  onChange,
  disabled = false,
  name,
}: RadioCardProps) {
  const id = useId();
  return (
    <fieldset className="lyx-radio-cards" aria-label={ariaLabel} disabled={disabled}>
      {options.map((option, index) => {
        const labelId = `${id}-${index}-label`;
        const descriptionId = `${id}-${index}-description`;
        const metaId = `${id}-${index}-meta`;
        const descriptions = [
          option.description != null ? descriptionId : null,
          option.meta != null ? metaId : null,
        ].filter(Boolean);
        return (
          <label className="lyx-radio-card" key={option.value}>
            <input
              className="lyx-w202-radio-input"
              type="radio"
              name={name ?? `lyx-card-${id}`}
              value={option.value}
              checked={value === option.value}
              disabled={disabled || option.disabled}
              aria-labelledby={labelId}
              aria-describedby={descriptions.length ? descriptions.join(" ") : undefined}
              onChange={() => {
                if (!disabled && !option.disabled) onChange(option.value);
              }}
            />
            <span className="lyx-radio-card__body">
              <span className="lyx-w202-radio-dot" aria-hidden="true" />
              {option.avatar != null ? (
                <span className="lyx-radio-card__avatar" aria-hidden="true">
                  {option.avatar}
                </span>
              ) : null}
              <span className="lyx-radio-card__text">
                <span className="lyx-radio-card__title" id={labelId}>
                  {option.label}
                </span>
                {option.description != null ? (
                  <span className="lyx-radio-card__description" id={descriptionId}>
                    {option.description}
                  </span>
                ) : null}
              </span>
              {option.meta != null ? (
                <span className="lyx-radio-card__meta" id={metaId}>
                  {option.meta}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
