import { expect, it } from "vitest";

import { connectTestDatabase } from "../database.js";
import { useTestDatabase } from "../worker.js";

// 有用例失败的文件：跑完之后它的库应当改名留着，名字打印出来（worker.test.ts 在外面核对）
const db = useTestDatabase("db", { label: "hookfail" });

it("建库并写一行", async () => {
  await db.url();
  const client = await connectTestDatabase(db.name);
  try {
    await client.query("create table lyx_hooks_probe as select 'fail'::text as outcome");
  } finally {
    await client.end();
  }
});

it("故意失败的一条", () => {
  expect.fail("夹具：这一条就是要失败");
});
