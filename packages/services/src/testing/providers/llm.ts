// 假素材理解：三种方法各有独立预置队列，按顺序各用一次；用完了给明确虚构样例。

import { ok } from "../../providers/types.js";
import type { LlmDigest, LlmProvider, ProviderMethodName } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<LlmProvider>;

export interface FakeLlm extends LlmProvider, FakeControl<Method> {
  /** 打标结果的预置，按顺序各用一次。用完了回 “样例素材”，标签是素材的类别 */
  readonly tagReplies: Array<{ description: string; tags: string[] }>;
  /** 要点的预置，按顺序各用一次。用完了把原文按句号拆开，取前 maxPoints 句（缺省 3） */
  readonly keyPointReplies: string[][];
  /** 完整结构化建议的明确预置；不挪用旧打标/要点队列。 */
  readonly digestReplies: LlmDigest[];
}

export function createFakeLlm(options: { clock?: FakeClock } = {}): FakeLlm {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const tagReplies: FakeLlm["tagReplies"] = [];
  const keyPointReplies: string[][] = [];
  const digestReplies: LlmDigest[] = [];

  return {
    status: "fake",
    configured: true,
    ...core.control,
    tagReplies,
    keyPointReplies,
    digestReplies,

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
    summarizeAsset: (input) =>
      core.run(
        "summarizeAsset",
        input,
        () => {
          // 仅测试替身的公开虚构样例；生产协议绝不补这些字段。
          const reply: LlmDigest = digestReplies.shift() ?? {
            title: "公开虚构摘要样例",
            keypoints: [],
            contentTags: [],
            suggestedUsage: [],
            faceHint: "none",
            qualityNotes: [],
          };
          return ok(structuredClone(reply));
        },
        input.signal,
      ),
  };
}
