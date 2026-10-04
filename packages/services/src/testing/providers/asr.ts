// 假录音转写：按地址给预置的文本；没预置的给一句样例。

import { ok } from "../../providers/types.js";
import type { AsrProvider, ProviderMethodName } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<AsrProvider>;

export interface FakeAsr extends AsrProvider, FakeControl<Method> {
  /** 预置：录音地址 → 转写文本。没预置的给 defaultText */
  readonly transcripts: Map<string, string>;
  defaultText: string;
}

export function createFakeAsr(options: { clock?: FakeClock } = {}): FakeAsr {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const transcripts = new Map<string, string>();

  const fake: FakeAsr = {
    status: "fake",
    configured: true,
    ...core.control,
    transcripts,
    defaultText: "这是替身给的转写文本。",

    transcribe: (input) =>
      core.run("transcribe", input, () => {
        const text = transcripts.get(input.url) ?? fake.defaultText;
        return ok({ text, durationSec: 30 });
      }),
  };
  return fake;
}
