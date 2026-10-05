import { beforeAll, it } from "vitest";

import { connectTestDatabase } from "../database.js";
import { useTestDatabase } from "../worker.js";

// beforeAll 里建了库、写了数据之后失败：用例一条没跑，库同样应当改名留着（worker.test.ts 在外面核对）
const db = useTestDatabase("db", { label: "sbefore" });

beforeAll(async () => {
  await db.url();
  const client = await connectTestDatabase(db.name);
  try {
    await client.query("create table lyx_hooks_probe as select 'before-all'::text as outcome");
  } finally {
    await client.end();
  }
  throw new Error("夹具：beforeAll 就是要失败");
});

it("跑不到的一条", () => {});
