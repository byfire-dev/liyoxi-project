import type { ReactNode } from "react";

import "./W202Controls.css";

export interface LogEntry {
  key: string;
  time: ReactNode;
  actor: ReactNode;
  content: ReactNode;
  /** 时间格式由调用方决定；可选机器可读时间供辅助技术消费。 */
  dateTime?: string;
}

export interface LogListProps {
  ariaLabel: string;
  entries: readonly LogEntry[];
  empty?: ReactNode;
}

export function LogList({ ariaLabel, entries, empty = "暂无记录" }: LogListProps) {
  return (
    <table className="lyx-log-list" aria-label={ariaLabel}>
      <colgroup>
        <col className="lyx-log-list__time-column" />
        <col className="lyx-log-list__actor-column" />
        <col />
      </colgroup>
      <thead className="lyx-w202-visually-hidden">
        <tr>
          <th scope="col">时间</th>
          <th scope="col">操作人</th>
          <th scope="col">内容</th>
        </tr>
      </thead>
      <tbody>
        {entries.length ? (
          entries.map((entry) => (
            <tr key={entry.key}>
              <td className="lyx-log-list__time">
                {entry.dateTime ? <time dateTime={entry.dateTime}>{entry.time}</time> : entry.time}
              </td>
              <td className="lyx-log-list__actor">{entry.actor}</td>
              <td>{entry.content}</td>
            </tr>
          ))
        ) : (
          <tr>
            <td className="lyx-log-list__empty" colSpan={3}>
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
