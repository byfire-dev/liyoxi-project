import type { ReactNode } from "react";

import { Icon } from "./Icon";

import "./W202Controls.css";

export interface StepperItem {
  key: string;
  label: ReactNode;
  status: "completed" | "current" | "upcoming";
}

export interface StepperProps {
  ariaLabel: string;
  steps: readonly StepperItem[];
}

const statusLabels = { completed: "已完成", current: "进行中", upcoming: "未到达" } as const;

/** 展示调用方给出的进度事实，不从步骤序号或领域状态推导。 */
export function Stepper({ ariaLabel, steps }: StepperProps) {
  return (
    <ol className="lyx-stepper" aria-label={ariaLabel}>
      {steps.map((step, index) => (
        <li
          className={`lyx-stepper__item lyx-stepper__item--${step.status}`}
          key={step.key}
          aria-current={step.status === "current" ? "step" : undefined}
        >
          <span className="lyx-stepper__node" aria-hidden="true">
            {step.status === "completed" ? <Icon name="check" size={16} /> : index + 1}
          </span>
          <span className="lyx-stepper__label">{step.label}</span>
          <span className="lyx-w202-visually-hidden">{statusLabels[step.status]}</span>
        </li>
      ))}
    </ol>
  );
}
