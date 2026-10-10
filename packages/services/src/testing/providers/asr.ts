// 假录音转写：按地址给预置的文本；没预置的给一句样例。

import { failed, ok } from "../../providers/types.js";
import type { AsrProvider, AsrTaskStatus, ProviderMethodName } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<AsrProvider>;

export interface FakeAsr extends AsrProvider, FakeControl<Method> {
  /** 预置：录音地址 → 转写文本。没预置的给 defaultText */
  readonly transcripts: Map<string, string>;
  defaultText: string;
  /** 新异步任务默认 waiting；只有用例显式给完成事实才返回 succeeded。 */
  readonly tasks: Map<string, AsrTaskStatus>;
}

export function createFakeAsr(options: { clock?: FakeClock } = {}): FakeAsr {
  const core = createFakeCore<Method>(options.clock ?? systemClock);
  const transcripts = new Map<string, string>();
  const tasks = new Map<string, AsrTaskStatus>();
  let nextTaskId = 1n;

  const fake: FakeAsr = {
    status: "fake",
    configured: true,
    ...core.control,
    transcripts,
    defaultText: "这是替身给的转写文本。",
    tasks,

    transcribe: (input) =>
      core.run("transcribe", input, () => {
        const text = transcripts.get(input.url) ?? fake.defaultText;
        return ok({ text, durationSec: 30 });
      }),
    async submit(input) {
      const preAborted = input.signal?.aborted ?? false;
      const result = await core.run(
        "submit",
        input,
        () => {
          const taskId = String(nextTaskId++);
          tasks.set(taskId, { taskId, requestId: "fake-asr", state: "waiting" });
          return ok({ taskId, requestId: "fake-asr" });
        },
        input.signal,
      );
      return result.ok
        ? result
        : {
            ...result,
            acceptance: preAborted ? "not_accepted" : "unknown",
            code: input.signal?.aborted ? "aborted" : "unknown_outcome",
          };
    },
    query: (input) =>
      core.run(
        "query",
        input,
        () => {
          const value = tasks.get(input.taskId);
          return value ? ok(value) : failed("rejected", "替身录音任务不存在");
        },
        input.signal,
      ),
  };
  return fake;
}
