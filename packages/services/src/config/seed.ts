// config 的种子（W0-21）：字典类型与初始项、开关、清单模板首版、站点配置初始版。数据在 seed-data.ts，开关取契约的登记。
// 没有才插，已有的行不改。参数值不播种：param_value 的保存人非空，库里没有的键取代码默认值（14 分组 第 2.3 节）。
import { FLAGS } from "@liyoxi/contract";
import type { FlagDef } from "@liyoxi/contract";
import { Prisma } from "@liyoxi/db";

import { defineSeed, insertMissing, uuidv7 } from "../kernel/index.js";
import type { SeedContext, SeedTableResult, Tx } from "../kernel/index.js";

import {
  CHECKLIST_TEMPLATE_SEEDS,
  DICT_ITEM_SEEDS,
  DICT_TYPE_SEEDS,
  nextCodeNoOf,
  SITE_CONFIG_SEEDS,
} from "./seed-data.js";
import type { DictItemSeed } from "./seed-data.js";
import { seedMissingSellingPoints } from "./selling-point-seeds.js";

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const itemKey = (item: { dictTypeKey: string; code: string }): string =>
  `${item.dictTypeKey}/${item.code}`;

/** 这一项的编码是不是该类型按顺序发的号（前缀加定长序号）。不是的就是固定编码：代码按编码引用 */
function isSequentialCode(item: DictItemSeed): boolean {
  const type = DICT_TYPE_SEEDS.find((entry) => entry.typeKey === item.dictTypeKey);
  if (!type?.code) return false;
  return new RegExp(`^${type.code.prefix}[0-9]{${type.code.width}}$`).test(item.code);
}

async function seedDicts(tx: Tx, { now }: SeedContext): Promise<SeedTableResult[]> {
  const typesBefore = new Set(
    (await tx.dictType.findMany({ select: { typeKey: true } })).map((row) => row.typeKey),
  );
  const types = await insertMissing({
    table: "dict_type",
    rows: DICT_TYPE_SEEDS,
    keyOf: (row) => row.typeKey,
    existingKeys: () => Promise.resolve([...typesBefore]),
    insert: (missing) =>
      tx.dictType.createMany({
        data: missing.map((row) => ({
          typeKey: row.typeKey,
          name: row.name,
          structure: row.structure,
          maxDepth: row.maxDepth,
          codePrefix: row.code?.prefix ?? null,
          codeWidth: row.code?.width ?? null,
          nextCodeNo: nextCodeNoOf(row),
          isSystem: row.isSystem,
          canCreate: row.canCreate,
          disablePolicy: row.disablePolicy,
          isMerchantVisible: row.isMerchantVisible,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  });

  // 按顺序发号的初始项随新类型一起播；既有类型的顺序号归后台，避免撞已发码。
  // 固定编码的项缺了就补；从未运营的空卖点类型在下方由持锁 helper 特例补齐并推进序号。
  const items = await insertMissing({
    table: "dict_item",
    rows: DICT_ITEM_SEEDS.filter(
      (item) => !isSequentialCode(item) || !typesBefore.has(item.dictTypeKey),
    ),
    keyOf: itemKey,
    existingKeys: async () =>
      (await tx.dictItem.findMany({ select: { dictTypeKey: true, code: true } })).map(itemKey),
    // 一条语句插入：同类型内的上级引用在语句结束时才检查
    insert: (missing) =>
      tx.dictItem.createMany({
        data: missing.map((row) => ({
          id: uuidv7(),
          dictTypeKey: row.dictTypeKey,
          code: row.code,
          parentCode: row.parentCode,
          name: row.name,
          description: row.description,
          ext: json(row.ext),
          position: row.position,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  });
  if (typesBefore.has("store_selling_point")) {
    const sellingPoints = await seedMissingSellingPoints(tx, now);
    return [
      types,
      {
        ...items,
        inserted: items.inserted + sellingPoints.inserted,
        existing: items.existing + sellingPoints.existing,
      },
    ];
  }
  return [types, items];
}

function seedFlags(tx: Tx, { now }: SeedContext): Promise<SeedTableResult> {
  return insertMissing({
    table: "feature_flag",
    rows: FLAGS as readonly FlagDef[],
    keyOf: (row) => row.key,
    existingKeys: async () =>
      (await tx.featureFlag.findMany({ select: { key: true } })).map((row) => row.key),
    insert: (missing) =>
      tx.featureFlag.createMany({
        data: missing.map((row) => ({
          key: row.key,
          valueType: row.valueType,
          // 默认值是 JSON 的 null 时写 JSON null，不是 SQL NULL（列非空）
          defaultValue: row.defaultValue === null ? Prisma.JsonNull : json(row.defaultValue),
          rules: [],
          exposedTo: row.exposedTo,
          description: row.description,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  });
}

function seedChecklists(tx: Tx, { now }: SeedContext): Promise<SeedTableResult> {
  return insertMissing({
    table: "checklist_template",
    rows: CHECKLIST_TEMPLATE_SEEDS,
    // 这个编码有过任何版本就不再播：之后的版本归后台
    keyOf: (row) => row.code,
    existingKeys: async () =>
      (await tx.checklistTemplate.findMany({ select: { code: true }, distinct: ["code"] })).map(
        (row) => row.code,
      ),
    insert: (missing) =>
      tx.checklistTemplate.createMany({
        data: missing.map((row) => ({
          id: uuidv7(),
          code: row.code,
          versionNo: 1,
          items: json(row.items),
          status: "active",
          activatedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  });
}

function seedSiteConfig(tx: Tx, { now }: SeedContext): Promise<SeedTableResult> {
  return insertMissing({
    table: "site_config_revision",
    rows: SITE_CONFIG_SEEDS,
    // 这个配置键有过任何修订（含草稿）就不再播
    keyOf: (row) => row.configKey,
    existingKeys: async () =>
      (
        await tx.siteConfigRevision.findMany({
          select: { configKey: true },
          distinct: ["configKey"],
        })
      ).map((row) => row.configKey),
    insert: (missing) =>
      tx.siteConfigRevision.createMany({
        data: missing.map((row) => ({
          id: uuidv7(),
          configKey: row.configKey,
          revNo: 1,
          status: "published",
          content: json(row.content),
          note: "初始版",
          publishedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  });
}

export const seed = defineSeed("config", async (tx, context) => [
  ...(await seedDicts(tx, context)),
  await seedFlags(tx, context),
  await seedChecklists(tx, context),
  await seedSiteConfig(tx, context),
]);
