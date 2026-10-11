import { beforeEach, expect, it } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import { createClock, useSeededDatabase } from "../testing/index.js";
import { createAlertFacts } from "./alert-facts.js";

const db = useSeededDatabase("services");
beforeEach(() => db.reset(), 60_000);

it.each(["media.model_budget_exhausted", "media.model_budget_unavailable"])(
  "正式登记%s可由真实writer写入、去重并等待关闭；不代表运行中的预算告警链",
  async (rule) => {
    const prisma = await db.prisma();
    const clock = createClock(new Date("2026-10-11T04:00:00Z"));
    const logs: Array<Record<string, unknown>> = [];
    const record = (fields: Record<string, unknown>) => {
      logs.push(fields);
    };
    const facts = createAlertFacts({
      tx: createTxRunner({ prisma, appEnv: "test" }),
      clock,
      logger: { info: record, warn: record, error: record },
    });
    const input = {
      rule,
      dimension: "2026-10-11",
      severity: "P2" as const,
      detail: {
        day: "2026-10-11",
        rows: 1,
        rawBody: "PRIVATE_MODEL_BODY",
        secretUrl: "PRIVATE_REDIS_URL",
      },
    };
    try {
      await facts.raise(input);
      const writing = facts.raise(input);
      await facts.close();
      await writing;
      expect(await prisma.alertEvent.count()).toBe(1);
      expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
        rule,
        fingerprint: `${rule}:2026-10-11`,
        kind: "event",
        status: "open",
        severity: "P2",
        occurrences: 2,
        notifyCount: 0,
        lastNotifiedAt: null,
        lastValue: { day: "2026-10-11", rows: 1 },
      });
      expect(await prisma.alertEvent.count({ where: { rule: "ops.unknown_rule" } })).toBe(0);
      await facts.raise(input);
      expect((await prisma.alertEvent.findFirstOrThrow()).occurrences).toBe(2);
      const serialized = JSON.stringify({ logs, row: await prisma.alertEvent.findFirstOrThrow() });
      expect(serialized).not.toContain("PRIVATE_MODEL_BODY");
      expect(serialized).not.toContain("PRIVATE_REDIS_URL");
    } finally {
      await facts.close();
    }
  },
  60_000,
);
