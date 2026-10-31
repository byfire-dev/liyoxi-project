import type { QueueId } from "@liyoxi/contract/registry";
import type { QueueChannel } from "../kernel/index.js";
import type { ProbeRule } from "./probe-rules.js";

// 与实际消费者配套（D7 §9.2）；promote沿media的100，docs为正式50。未装配队列不制造健康零值。
const limits: Partial<Record<QueueId, number>> = {
  outbox_delivery: 500,
  timer_run: 200,
  notify: 500,
  media_job: 100,
  promote: 100,
  docs: 50,
};
export function queueProbeRules(
  queues: readonly QueueId[],
  observe?: QueueChannel["observe"],
): readonly ProbeRule[] {
  return [...new Set(queues)].map((queue) => {
    const limit = limits[queue];
    if (limit === undefined) throw new TypeError(`已装配队列缺少正式积压阈值：${queue}`);
    return {
      key: `queue.${queue}`,
      targets: [{ rule: "queue.backlog", dimension: queue }],
      async sample(at) {
        if (!observe) throw new Error("已装配队列缺少真实观测口");
        const facts = await observe(queue, at, limit + 1);
        const oldestAgeSec =
            facts.oldestWaitingAt === null
              ? null
              : Math.max(0, (at.getTime() - facts.oldestWaitingAt) / 1000),
          pausedForSec =
            facts.pausedSince === null
              ? null
              : Math.max(0, (at.getTime() - facts.pausedSince) / 1000),
          backlog =
            facts.waiting > limit ||
            (oldestAgeSec !== null && oldestAgeSec > 300) ||
            (facts.paused && pausedForSec !== null && pausedForSec > 600);
        if (
          !backlog &&
          (!facts.oldestWaitingComplete ||
            (facts.waiting > 0 && oldestAgeSec === null) ||
            (facts.paused && pausedForSec === null))
        )
          throw new TypeError("队列观测不完整");
        return backlog
          ? [
              {
                rule: "queue.backlog",
                dimension: queue,
                severity: "P2" as const,
                detail: {
                  waiting: facts.waiting,
                  active: facts.active,
                  failed10Min: facts.failed10Min,
                  oldestWaitingAgeSec: oldestAgeSec,
                  oldestWaitingComplete: facts.oldestWaitingComplete,
                  paused: facts.paused,
                  pausedForSec,
                  pauseTimeSource: facts.pauseTimeSource,
                },
              },
            ]
          : [];
      },
    };
  });
}
