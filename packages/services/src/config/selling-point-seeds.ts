import type { SeedTableResult, Tx } from "../kernel/index.js";
import { insertDictItemsMissing } from "./insert-dict-items.js";
import { STORE_SELLING_POINT_SEEDS } from "./seed-data.js";

/** 只修补从未运营的空类型；已有、停用或曾清空的候选全部归运营维护。 */
export async function seedMissingSellingPoints(tx: Tx, now: Date): Promise<SeedTableResult> {
  const typeKey = "store_selling_point";
  await tx.$queryRaw`SELECT type_key FROM dict_type WHERE type_key=${typeKey} FOR UPDATE`;
  const type = await tx.dictType.findUnique({ where: { typeKey } });
  if (!type) throw new Error("门店核心卖点字典类型未初始化，请先运行标准种子");
  const current = await tx.dictItem.findMany({
    where: { dictTypeKey: typeKey },
    select: { code: true },
  });
  const unchanged = {
    table: "dict_item",
    inserted: 0,
    existing: STORE_SELLING_POINT_SEEDS.filter((row) =>
      current.some((item) => item.code === row.code),
    ).length,
  };
  if (
    current.length > 0 ||
    type.versionNo !== 1 ||
    type.nextCodeNo !== 1 ||
    type.codePrefix !== "SP" ||
    type.codeWidth !== 2
  )
    return unchanged;
  // helper 复用同一事务的类型锁，插入时同步推进版本与 next_code_no。
  return insertDictItemsMissing(tx, STORE_SELLING_POINT_SEEDS, now);
}
