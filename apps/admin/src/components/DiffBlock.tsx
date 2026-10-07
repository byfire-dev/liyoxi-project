import { useId, type ReactNode } from "react";

import "./W202Controls.css";

export interface DiffBlockProps {
  ariaLabel: string;
  before: ReactNode;
  after: ReactNode;
  beforeLabel?: string;
  afterLabel?: string;
}

/** 仅展示调用方给出的前后内容，不比对明文或生成业务差异。 */
export function DiffBlock({
  ariaLabel,
  before,
  after,
  beforeLabel = "变更前",
  afterLabel = "变更后",
}: DiffBlockProps) {
  const id = useId();
  return (
    <div className="lyx-diff-block" role="group" aria-label={ariaLabel}>
      <section
        className="lyx-diff-block__panel lyx-diff-block__panel--before"
        aria-labelledby={`${id}-before`}
      >
        <h3 id={`${id}-before`}>{beforeLabel}</h3>
        <div>{before}</div>
      </section>
      <section
        className="lyx-diff-block__panel lyx-diff-block__panel--after"
        aria-labelledby={`${id}-after`}
      >
        <h3 id={`${id}-after`}>{afterLabel}</h3>
        <div>{after}</div>
      </section>
    </div>
  );
}
