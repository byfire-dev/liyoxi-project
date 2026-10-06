import { BOOTSTRAP_BLOCKS, BootstrapSchema } from "@liyoxi/contract";
import { describe, expect, it } from "vitest";
import { assembleBootstrap, bootstrapDefaults } from "./bootstrap.js";
import type { BootstrapLoaders } from "./bootstrap.js";

const now = new Date("2026-10-06T03:00:00Z");
const loaders = (loggedIn: boolean): BootstrapLoaders => {
  const defaults = bootstrapDefaults(loggedIn);
  return {
    flags: async () => defaults.flags,
    versions: async () => defaults.versions,
    consents: async () => defaults.consents,
    subscribe: async () => defaults.subscribe,
    copy: async () => defaults.copy,
    notice: async () => defaults.notice,
    context: async () => defaults.context,
  };
};
describe("引导独立降级", () => {
  for (const failed of BOOTSTRAP_BLOCKS)
    it(`${failed} 失败不影响其余块，并按稳定顺序登记 degraded`, async () => {
      const blocks = loaders(true);
      blocks[failed] = async () => {
        throw new Error("取数失败");
      };
      const result = await assembleBootstrap(now, true, blocks);
      expect(result.degraded).toEqual([failed]);
      expect(result.serverTime).toBe(now.toISOString());
      expect(BootstrapSchema.safeParse(result).success).toBe(true);
    });
  it("全部块失败才 INTERNAL", async () => {
    const blocks = loaders(true);
    for (const key of BOOTSTRAP_BLOCKS)
      blocks[key] = async () => {
        throw new Error("取数失败");
      };
    await expect(assembleBootstrap(now, true, blocks)).rejects.toMatchObject({ error: "INTERNAL" });
  });
  it("匿名个人块为空，登录后 M1 订阅是空数组", async () => {
    const anonymous = await assembleBootstrap(now, false, loaders(false));
    expect([anonymous.pendingConsents, anonymous.subscribePlan, anonymous.context]).toEqual([
      null,
      null,
      null,
    ]);
    const logged = await assembleBootstrap(now, true, loaders(true));
    expect(logged.subscribePlan).toEqual([]);
    expect(logged.support).toEqual({ mode: "contact", corpId: null, kfUrl: null });
  });
});
