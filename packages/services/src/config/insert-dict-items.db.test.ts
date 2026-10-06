import { it, expect } from "vitest";
import { useSeededDatabase, createClock } from "../testing/index.js";
import { createTxRunner } from "../kernel/index.js";
import { insertDictItemsMissing } from "./insert-dict-items.js";
const db = useSeededDatabase("services"),
  clock = createClock();
it("只新增缺项，保留同编码已编辑/停用项；版本与顺序编码只随新项前移", async () => {
  const prisma = await db.prisma(),
    tx = createTxRunner({ prisma, appEnv: "test" });
  const row = {
    dictTypeKey: "genre",
    code: "G01",
    parentCode: null,
    name: "原始题材",
    description: null,
    ext: {},
    position: 0,
  };
  const initial = await prisma.dictType.findUniqueOrThrow({ where: { typeKey: "genre" } });
  expect((await tx.run((t) => insertDictItemsMissing(t, [row], clock.now()))).inserted).toBe(1);
  await prisma.dictItem.updateMany({
    where: { dictTypeKey: "genre", code: "G01" },
    data: { name: "已编辑题材", isEnabled: false },
  });
  const result = await tx.run((t) =>
    insertDictItemsMissing(
      t,
      [row, { ...row, code: "G02", name: "第二题材", position: 1 }],
      clock.now(),
    ),
  );
  expect(result).toMatchObject({ inserted: 1, existing: 1 });
  expect(
    await prisma.dictItem.findFirstOrThrow({ where: { dictTypeKey: "genre", code: "G01" } }),
  ).toMatchObject({ name: "已编辑题材", isEnabled: false });
  const version = await prisma.dictType.findUniqueOrThrow({ where: { typeKey: "genre" } });
  expect(version).toMatchObject({ versionNo: initial.versionNo + 2, nextCodeNo: 3 });
  expect((await tx.run((t) => insertDictItemsMissing(t, [row], clock.now()))).inserted).toBe(0);
  expect((await prisma.dictType.findUniqueOrThrow({ where: { typeKey: "genre" } })).versionNo).toBe(
    version.versionNo,
  );
});
