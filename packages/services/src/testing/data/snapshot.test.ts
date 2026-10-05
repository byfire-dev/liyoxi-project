// 表快照比较器的纯计算部分：不连库，拿手写的快照比（任务书 W0-25 第 7 节第 4 条）。
import { describe, expect, it } from "vitest";

import { assertSnapshotsEqual, diffSnapshots, formatSnapshotDiff } from "./snapshot.js";
import type { SnapshotRow, TablesSnapshot } from "./snapshot.js";

const snap = (tables: Record<string, SnapshotRow[]>): TablesSnapshot =>
  Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [table, { table, keyColumns: ["id"], rows }]),
  );

const before = snap({
  drama_order: [
    { id: "a", status: "pending_start", updated_at: "t1", note: null },
    { id: "b", status: "producing", updated_at: "t1", note: null },
  ],
  order_item: [{ id: "x", phase: "pending_start", snapshot: { a: 1, b: [1, 2] } }],
});

describe("diffSnapshots", () => {
  it("没变：equal 为真，没有表", () => {
    const diff = diffSnapshots(before, structuredClone(before));
    expect(diff).toEqual({ equal: true, tables: [] });
    expect(formatSnapshotDiff(diff)).toBe("没有差异");
    expect(() => assertSnapshotsEqual(before, structuredClone(before))).not.toThrow();
  });

  it("增、删、改各报得出；改的行列出变了哪几列", () => {
    const after = snap({
      drama_order: [
        { id: "a", status: "producing", updated_at: "t2", note: null },
        { id: "c", status: "pending_start", updated_at: "t2", note: "新的" },
      ],
      order_item: [{ id: "x", phase: "pending_start", snapshot: { b: [1, 2], a: 1 } }],
    });
    const diff = diffSnapshots(before, after);
    expect(diff.equal).toBe(false);
    // jsonb 里键的先后不算差异：order_item 没变，不在结果里
    expect(diff.tables.map((item) => item.table)).toEqual(["drama_order"]);
    const [orders] = diff.tables;
    expect(orders?.added.map((row) => row.id)).toEqual(["c"]);
    expect(orders?.removed.map((row) => row.id)).toEqual(["b"]);
    expect(orders?.changed).toEqual([
      {
        key: { id: "a" },
        columns: ["status", "updated_at"],
        before: before.drama_order?.rows[0],
        after: after.drama_order?.rows[0],
      },
    ]);
    expect(formatSnapshotDiff(diff)).toBe(
      [
        "drama_order：增 1 行，删 1 行，改 1 行",
        '  增 {"id":"c","note":"新的","status":"pending_start","updated_at":"t2"}',
        '  删 {"id":"b","note":null,"status":"producing","updated_at":"t1"}',
        '  改 {"id":"a"}：status "pending_start" → "producing"；updated_at "t1" → "t2"',
      ].join("\n"),
    );
    expect(() => assertSnapshotsEqual(before, after)).toThrow(
      /表快照不一致：\ndrama_order：增 1 行/,
    );
  });

  it("忽略的列变了不算改：给清单、按表给、用 * 给，三种写法", () => {
    const after = snap({
      drama_order: [
        { id: "a", status: "pending_start", updated_at: "t2", note: null },
        { id: "b", status: "producing", updated_at: "t2", note: null },
      ],
      order_item: [{ id: "x", phase: "producing", snapshot: { a: 1, b: [1, 2] } }],
    });
    expect(diffSnapshots(before, after).tables.map((item) => item.table)).toEqual([
      "drama_order",
      "order_item",
    ]);
    expect(
      diffSnapshots(before, after, { ignore: ["updated_at"] }).tables.map((item) => item.table),
    ).toEqual(["order_item"]);
    expect(
      diffSnapshots(before, after, { ignore: { "*": ["updated_at"], order_item: ["phase"] } }),
    ).toEqual({ equal: true, tables: [] });
    // 按表给的只管那张表
    expect(
      diffSnapshots(before, after, { ignore: { order_item: ["updated_at", "phase"] } }).tables.map(
        (item) => item.table,
      ),
    ).toEqual(["drama_order"]);
  });

  it("两边的表不一样、认行的列不一样：抛错，不给出似是而非的结果", () => {
    expect(() => diffSnapshots(before, snap({ drama_order: [] }))).toThrow(/表不一样/);
    const other: TablesSnapshot = {
      ...before,
      order_item: { table: "order_item", keyColumns: ["phase"], rows: [] },
    };
    expect(() => diffSnapshots(before, other)).toThrow(/认行的列不一样/);
  });
});
