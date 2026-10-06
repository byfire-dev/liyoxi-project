import type { ReactNode } from "react";
import "./ReviewPrimitives.css";

export interface CompareRow {
  key: string;
  label: ReactNode;
  value: ReactNode;
  result: ReactNode;
}

/** 只展示服务端事实；领域适配方提供字段与比对文案。 */
export function CompareTable({
  rows,
  ariaLabel,
}: {
  rows: readonly CompareRow[];
  ariaLabel: string;
}) {
  return (
    <table className="lyx-review-compare" aria-label={ariaLabel}>
      <thead>
        <tr>
          <th>字段</th>
          <th>已提交资料</th>
          <th>系统比对</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.label}</td>
            <td>{row.value}</td>
            <td>{row.result}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
