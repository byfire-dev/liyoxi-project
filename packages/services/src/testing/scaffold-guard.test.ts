import type * as DbTesting from "@liyoxi/db/testing";
import { expect, it, vi } from "vitest";

// useTestRedis 一上来先核对本项目挂了测试支架的 globalSetup（W0-05b）：只连 Redis、不连库的包不挂也跑得起来，
// 但 pnpm test:isolation --scope connected 按“挂没挂 globalSetup”认项目，没挂的会被漏在外面，所以这里直接拦。
// 核对本身（取不到 globalSetup 给的并行数即抛错）在 packages/db 的 worker.test.ts 里用嵌套的一轮验；
// 这里把它换成一个必抛的，只验 useTestRedis 确实先调了它、没过就不往下走。

vi.mock("@liyoxi/db/testing", async (importOriginal) => ({
  ...(await importOriginal<typeof DbTesting>()),
  assertTestScaffoldAttached: () => {
    throw new Error("没有挂测试支架的 globalSetup（用例里换上的）");
  },
}));

it("useTestRedis：本项目没挂 globalSetup 即抛错，不发前缀、不登记收尾", async () => {
  const { useTestRedis } = await import("./redis.js");
  expect(() => useTestRedis()).toThrow("没有挂测试支架的 globalSetup（用例里换上的）");
});
