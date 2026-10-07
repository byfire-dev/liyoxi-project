import { Icon } from "./Icon";

import "./W202Controls.css";

export interface MonthValue {
  year: number;
  month: number;
}

export interface MonthSwitcherProps {
  value: MonthValue;
  onChange: (value: MonthValue) => void;
  min?: MonthValue;
  max?: MonthValue;
  disabled?: boolean;
  ariaLabel?: string;
}

function validMonth(value: MonthValue): boolean {
  return (
    Number.isInteger(value.year) &&
    value.year >= 1 &&
    value.year <= 9999 &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12
  );
}

function monthNumber(value: MonthValue): number {
  return (value.year - 1) * 12 + value.month - 1;
}

/** 仅做月份导航；调用方保存月份并提供可选范围，不生成业务月历。 */
export function MonthSwitcher({
  value,
  onChange,
  min,
  max,
  disabled = false,
  ariaLabel = "月份",
}: MonthSwitcherProps) {
  const valid = validMonth(value) && (!min || validMonth(min)) && (!max || validMonth(max));
  const lower = min ? monthNumber(min) : 0;
  const upper = max ? monthNumber(max) : 9999 * 12 - 1;
  const current = monthNumber(value);
  const canMove = (direction: -1 | 1) =>
    !disabled && valid && current + direction >= lower && current + direction <= upper;
  const move = (direction: -1 | 1) => {
    if (!canMove(direction)) return;
    const next = current + direction;
    onChange({ year: Math.floor(next / 12) + 1, month: (next % 12) + 1 });
  };
  return (
    <div className="lyx-month-switcher" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className="lyx-month-switcher__arrow"
        aria-label="上一个月"
        disabled={!canMove(-1)}
        onClick={() => move(-1)}
      >
        <Icon name="chevron-left" size={16} />
      </button>
      <span className="lyx-month-switcher__value" aria-live="polite" aria-atomic="true">
        {valid ? `${value.year} 年 ${value.month} 月` : "月份无效"}
      </span>
      <button
        type="button"
        className="lyx-month-switcher__arrow"
        aria-label="下一个月"
        disabled={!canMove(1)}
        onClick={() => move(1)}
      >
        <Icon name="chevron-right" size={16} />
      </button>
    </div>
  );
}
