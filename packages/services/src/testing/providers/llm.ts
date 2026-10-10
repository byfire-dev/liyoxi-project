// 假素材理解：打标与要点各有一个预置队列，按顺序各用一次；用完了给样例。

import { ok } from "../../providers/types.js";
import type { LlmProvider, ProviderMethodName } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<LlmProvider>;

export interface FakeLlm extends LlmProvider, FakeControl<Method> {
  /** 打标结果的预置，按顺序各用一次。用完了回 “样例素材”，标签是素材的类别 */
  readonly tagReplies: Array<{ description: string; tags: string[] }>;
  /** 要点的预置，按顺序各用一次。用完了把原文按句号拆开，取前 maxPoints 句（缺省 3） */
  readonly keyPointReplies: string[][];
}

export function createFakeLlm(options: { clock?: FakeClock } = {}): FakeLlm {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const tagReplies: FakeLlm["tagReplies"] = [];
  const keyPointReplies: string[][] = [];

  return {
    status: "fake",
    configured: true,
    ...core.control,
    tagReplies,
    keyPointReplies,

    tagAsset: (input) =>
      core.run(
        "tagAsset",
        input,
        () => {
          const reply = tagReplies.shift() ?? { description: "样例素材", tags: [input.kind] };
          return ok({ description: reply.description, tags: [...reply.tags] });
        },
        input.signal,
      ),
    extractKeyPoints: (input) =>
      core.run(
        "extractKeyPoints",
        input,
        () => {
          const preset = keyPointReplies.shift();
          const points =
            preset ??
            input.text
              .split("。")
              .map((sentence) => sentence.trim())
              .filter((sentence) => sentence !== "")
              .slice(0, input.maxPoints ?? 3);
          return ok({ points: [...points] });
        },
        input.signal,
      ),
  };
}
