import type { PrismaClient } from "@liyoxi/db";
import { createPublishLists } from "../delivery/index.js";
import { createLaunchRevoke } from "../publish/index.js";
import { m5Harness, released, releaseSteps, checks } from "./delivery-release.fixture.js";
import { bindUsageLifecycleOrderForTest } from "./usage-lifecycle.fixture.js";

/** Real production and push writers plus the actual order rederive port. */
export function createPublishWorkbenchFixture(prisma: PrismaClient) {
  const h = m5Harness(prisma);
  const unbind = bindUsageLifecycleOrderForTest(h);
  return {
    ...h,
    publishLists: createPublishLists(h.deps),
    launchRevoke: createLaunchRevoke({ ...h.deps, approval: h.approval }),
    release: (twoAccounts = false, episodeCount = 1, beforePush?: Parameters<typeof released>[2]) =>
      released(h, twoAccounts, beforePush, episodeCount),
    releaseSteps: (
      twoAccounts = false,
      episodeCount = 1,
      beforePush?: Parameters<typeof released>[2],
    ) => releaseSteps(h, twoAccounts, beforePush, episodeCount),
    checks: (code: string) => checks(h, code),
    async close() {
      unbind();
      await h.close();
    },
  };
}
