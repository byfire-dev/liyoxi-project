// 把真实店员结构扩出 balance（默认值保证它出现在回包），跑同一个字段检查。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export default {
  gate: "店员字段防回归（pnpm test）",
  mutation: "MeOverviewForClerk 加 balance 默认字段",
  reason: /店员禁用字段：m\.me\.overview\.get balance/,
  run(ctx) {
    const manifest = JSON.parse(readFileSync(join(ctx.repoRoot, "package.json"), "utf8"));
    const apiConfig = readFileSync(join(ctx.repoRoot, "apps/api/vitest.config.ts"), "utf8");
    const rootConfig = readFileSync(join(ctx.repoRoot, "vitest.config.ts"), "utf8");
    if (
      manifest.scripts.test !== "vitest run" ||
      !apiConfig.includes('"test/**/*.test.ts"') ||
      !rootConfig.includes('"apps/{api,worker}"')
    )
      throw new Error("店员防回归未接入 pnpm test");
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, {
      "mutant.ts": `
      import { MeOverviewForClerkSchema, z } from ${JSON.stringify(join(ctx.repoRoot, "packages/contract/src/index.ts"))};
      import { clerkVisibleKeys } from ${JSON.stringify(join(ctx.repoRoot, "apps/api/test/clerk/visible-keys.ts"))};
      const schema = MeOverviewForClerkSchema.extend({ balance: z.int().default(0) });
      const data = schema.parse({ viewerRole: "clerk", currentStore: {
        storeId: "01928e77-4000-7000-8000-000000000001", name: "春熙店", isPrimary: true,
        lifecycle: "active", qualificationStatus: "unsubmitted", city: null, category: null,
        role: "clerk", assetCount: 0, clerkCount: 1
      }, stores: { visibleCount: 1 }, unreadMessageCount: 0 });
      clerkVisibleKeys("m.me.overview.get", data);
    `,
    });
    return ctx.run("pnpm", ["--filter", "@liyoxi/contract", "exec", "tsx", join(dir, "mutant.ts")]);
  },
};
