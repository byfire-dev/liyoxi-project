import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

import { balanceIsolationShards, parseIsolationTimings } from "./isolation-balance.mjs";

// 仅普通 CI 四片重排归属；全集、各片容量与片内 sort 始终沿用 Vitest。
// 隔离脚本枚举时没有显式 !infra，仍得到原 hash 分片，再走自己的八片调度。
export default class BalancedTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const originalShard = config.shard;
    if (
      originalShard?.count !== 4 ||
      config.project.length !== 1 ||
      config.project[0] !== "!infra"
    ) {
      return super.shard(files);
    }

    const baseline = [];
    try {
      for (let index = 1; index <= 4; index++) {
        config.shard = { index, count: 4 };
        baseline.push(
          (await super.shard(files)).map((spec) => ({
            project: spec.project.name,
            file: relative(config.root, spec.moduleId).replaceAll("\\", "/"),
            spec,
          })),
        );
      }
    } finally {
      config.shard = originalShard;
    }

    const hints = JSON.parse(readFileSync(new URL("./test-timings.json", import.meta.url), "utf8"));
    const groups = balanceIsolationShards(
      baseline,
      parseIsolationTimings(hints),
      hints.initialLoadsMilliseconds,
    );
    return groups[originalShard.index - 1]!.map(({ spec }) => spec);
  }
}
