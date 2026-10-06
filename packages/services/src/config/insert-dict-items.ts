// 演示补项：同编码已有就不改；类型序号和版本随新插入项前移（W1-13）。
import type { Prisma } from "@liyoxi/db";
import { insertMissing, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { DictItemSeed } from "./seed-data.js";
export async function insertDictItemsMissing(tx: Tx, rows: readonly DictItemSeed[], now: Date) {
  const types = [...new Set(rows.map((row) => row.dictTypeKey))].sort();
  // 字典类型是自然主键，固定排序锁住，防两个补项运行器发出同一批编码。
  for (const type of types)
    await tx.$queryRaw`SELECT type_key FROM dict_type WHERE type_key=${type} FOR UPDATE`;
  const result = await insertMissing({
    table: "dict_item",
    rows,
    keyOf: (row) => `${row.dictTypeKey}/${row.code}`,
    existingKeys: async () =>
      (
        await tx.dictItem.findMany({
          where: { dictTypeKey: { in: types } },
          select: { dictTypeKey: true, code: true },
        })
      ).map((row) => `${row.dictTypeKey}/${row.code}`),
    insert: async (missing) => {
      const inserted = await tx.dictItem.createMany({
        data: missing.map((row) => ({
          id: uuidv7(),
          ...row,
          ext: row.ext as Prisma.InputJsonValue,
          createdAt: now,
          updatedAt: now,
        })),
      });
      for (const typeKey of types) {
        const items = missing.filter((row) => row.dictTypeKey === typeKey);
        if (!items.length) continue;
        const type = await tx.dictType.findUniqueOrThrow({ where: { typeKey } });
        let next = type.nextCodeNo;
        for (const row of items) {
          if (
            type.codePrefix &&
            type.codeWidth &&
            new RegExp(`^${type.codePrefix}[0-9]{${type.codeWidth}}$`).test(row.code)
          )
            next = Math.max(next ?? 1, Number(row.code.slice(type.codePrefix.length)) + 1);
        }
        await tx.dictType.update({
          where: { typeKey },
          data: { nextCodeNo: next, versionNo: { increment: 1 }, updatedAt: now },
        });
      }
      return inserted;
    },
  });
  return result;
}
