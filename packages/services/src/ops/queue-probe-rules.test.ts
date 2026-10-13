import { expect, it } from "vitest";
import type { QueueObservation } from "../kernel/index.js";
import { queueProbeRules } from "./queue-probe-rules.js";

it("五队列数量/最老/全局暂停严格边界，失败数仅detail，不完整和缺测走未知", async () => {
  const at = new Date("2026-10-13T00:00:00Z");
  let facts: QueueObservation;
  const clear = (): QueueObservation => ({
    waiting: 0,
    active: 7,
    failed10Min: 0,
    oldestWaitingAt: null,
    oldestWaitingComplete: true,
    paused: false,
    pausedSince: null,
    pauseTimeSource: "none",
  });
  const expected = {
    outbox_delivery: 500,
    timer_run: 200,
    notify: 500,
    media_job: 100,
    promote: 100,
  } as const;
  for (const queue of Object.keys(expected) as (keyof typeof expected)[]) {
    const calls: number[] = [],
      rule = queueProbeRules([queue], async (id, time, limit) => {
        expect(id).toBe(queue);
        expect(time).toBe(at);
        calls.push(limit!);
        return facts;
      })[0]!;
    expect(rule.targets).toEqual([{ rule: "queue.backlog", dimension: queue }]);
    facts = { ...clear(), waiting: expected[queue], oldestWaitingAt: at.getTime() - 300_000 };
    expect(await rule.sample(at)).toEqual([]);
    facts = {
      ...clear(),
      waiting: expected[queue] + 1,
      oldestWaitingComplete: false,
      failed10Min: 9,
    };
    expect(await rule.sample(at)).toMatchObject([
      {
        rule: "queue.backlog",
        dimension: queue,
        severity: "P2",
        detail: { failed10Min: 9, oldestWaitingAgeSec: null, oldestWaitingComplete: false },
      },
    ]);
    facts = { ...clear(), waiting: 1, oldestWaitingAt: at.getTime() - 300_001 };
    expect(await rule.sample(at)).toHaveLength(1);
    facts = {
      ...clear(),
      paused: true,
      pausedSince: at.getTime() - 600_000,
      pauseTimeSource: "event",
    };
    expect(await rule.sample(at)).toEqual([]);
    facts = { ...facts, pausedSince: at.getTime() - 600_001 };
    expect(await rule.sample(at)).toHaveLength(1);
    facts = { ...clear(), failed10Min: 10000 };
    expect(await rule.sample(at)).toEqual([]);
    facts = { ...clear(), waiting: 1, oldestWaitingComplete: false };
    await expect(rule.sample(at)).rejects.toThrow("不完整");
    expect(calls.every((limit) => limit === expected[queue] + 1 && limit <= 501)).toBe(true);
  }
  await expect(queueProbeRules(["notify"])[0]!.sample(at)).rejects.toThrow("缺少真实观测口");
  await expect(
    queueProbeRules(["notify"], async () => {
      throw new Error("lyxtest unavailable");
    })[0]!.sample(at),
  ).rejects.toThrow("unavailable");
  expect(queueProbeRules([])).toEqual([]);
  expect(() => queueProbeRules(["docs"])).toThrow("阈值");
});
