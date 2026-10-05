// staff 的种子（W0-21）：8 个固定角色，取契约里的代码默认配置（03 分组 第 2.1 节）。
// 没有才插：后台改过的模块等级、权限点开关、数据范围都留着；权限点登记以后多出来的键不回填进已有的行
//（库里缺的键读时取代码默认值，03 分组 第 4 节）。
import { defaultRoleActions, STAFF_ROLE_DEFAULTS } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";

import { defineSeed, insertMissing } from "../kernel/index.js";

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export const seed = defineSeed("staff", async (tx, { now }) => [
  await insertMissing({
    table: "staff_role",
    rows: STAFF_ROLE_DEFAULTS,
    keyOf: (row) => row.key,
    existingKeys: async () =>
      (await tx.staffRole.findMany({ select: { key: true } })).map((row) => row.key),
    insert: (missing) =>
      tx.staffRole.createMany({
        data: missing.map((row) => ({
          key: row.key,
          name: row.name,
          description: row.description,
          moduleLevels: json(row.moduleLevels),
          actions: json(defaultRoleActions(row.key)),
          dataScope: row.dataScope,
          isLocked: row.isLocked,
          availableFrom: row.availableFrom,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  }),
]);
