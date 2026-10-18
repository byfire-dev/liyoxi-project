import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTxRunner } from "../kernel/index.js";
import { createClock, useSeededDatabase } from "../testing/index.js";
import { createAlertFacts } from "./alert-facts.js";

const db = useSeededDatabase("services");
const owners: Array<ReturnType<typeof createAlertFacts>> = [];
beforeEach(() => db.reset(), 60_000);
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map((owner) => owner.close()));
  vi.restoreAllMocks();
});
const input = {
  rule: "evidence.consent_digest_mismatch",
  dimension: "2026-10-08",
  severity: "P2" as const,
  detail: { day: "2026-10-08", rows: 3, phone: "13800138000", rawBody: "private" },
};
async function build() {
  const prisma = await db.prisma();
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const clock = createClock(new Date("2026-10-09T04:00:00Z"));
  const logs: Array<Record<string, unknown>> = [];
  const log = (fields: Record<string, unknown>) => {
    logs.push(fields);
  };
  const facts = createAlertFacts({ tx, clock, logger: { info: log, warn: log, error: log } });
  owners.push(facts);
  return { prisma, tx, clock, facts, logs };
}

describe("事件告警事实持久化", () => {
  it("20个并发同指纹只留一行，计数无丢失、级别只升不降", async () => {
    const { facts, prisma } = await build();
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        facts.raise({
          ...input,
          severity: n === 12 ? "P1" : "P2",
        }),
      ),
    );
    expect(await prisma.alertEvent.count()).toBe(1);
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      fingerprint: "evidence.consent_digest_mismatch:2026-10-08",
      severity: "P1",
      occurrences: 20,
      kind: "event",
      status: "open",
      notifyCount: 0,
      lastNotifiedAt: null,
    });
    await facts.raise({ ...input, severity: "P3" });
    expect(await prisma.alertEvent.findFirstOrThrow()).toMatchObject({
      severity: "P1",
      occurrences: 21,
    });
  });

  it("未知规则按原受控事实登记，非法维度不写入，详情不含个人信息或异常", async () => {
    const { facts, prisma, logs } = await build();
    await facts.raise(input);
    expect((await prisma.alertEvent.findFirstOrThrow()).lastValue).toEqual({
      day: "2026-10-08",
      rows: 3,
    });
    await facts.raise({ ...input, rule: "unknown.example" });
    expect(
      await prisma.alertEvent.findFirstOrThrow({ where: { rule: "ops.unknown_rule" } }),
    ).toMatchObject({
      fingerprint: "ops.unknown_rule:unknown.example",
      severity: "P2",
    });
    await facts.raise({ ...input, dimension: "invalid\nprivate" });
    expect(await prisma.alertEvent.count()).toBe(2);
    expect(logs.some((row) => row["evt"] === "ops.alert_write_failed")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("private");
    expect(JSON.stringify(logs)).not.toContain("13800138000");
  });

  it("独立写失败仅记固定日志，不改业务提交或覆盖原异常", async () => {
    const { facts, prisma, tx, logs } = await build();
    await tx.run(async (handle) => {
      await handle.bizSequence.create({
        data: { prefix: "FG", bizDate: new Date("2026-10-09"), nextVal: 1 },
      });
      const failure = vi.spyOn(tx, "run").mockRejectedValueOnce(new Error("SECRET_DATABASE"));
      try {
        await expect(facts.raise(input)).resolves.toBeUndefined();
      } finally {
        failure.mockRestore();
      }
    });
    expect(await prisma.bizSequence.count({ where: { prefix: "FG" } })).toBe(1);
    const original = new Error("original business error");
    await expect(
      tx.run(async () => {
        const failure = vi.spyOn(tx, "run").mockRejectedValueOnce(new Error("SECRET_DATABASE"));
        try {
          await facts.raise(input);
        } finally {
          failure.mockRestore();
        }
        throw original;
      }),
    ).rejects.toBe(original);
    expect(logs.filter((row) => row["evt"] === "ops.alert_write_failed")).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain("SECRET_DATABASE");
    expect(await prisma.alertEvent.count()).toBe(0);
  });

  it("关闭等待真实行锁阻塞的在途写，关闭后不新增，其他实例继续写", async () => {
    const first = await build(),
      second = await build();
    await first.facts.raise(input);
    let release!: () => void, announce!: () => void;
    let holderPid = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const held = first.tx.run(async (handle) => {
      const backend = await handle.$queryRawUnsafe<Array<{ pid: number }>>(
        "SELECT pg_backend_pid() AS pid",
      );
      holderPid = backend[0]!.pid;
      await handle.$queryRawUnsafe(
        "SELECT id FROM alert_event WHERE fingerprint=$1 FOR UPDATE",
        "evidence.consent_digest_mismatch:2026-10-08",
      );
      announce();
      await gate;
    });
    await locked;
    const writing = first.facts.raise(input);
    let closed = false;
    const closing = first.facts.close().then(() => {
      closed = true;
    });
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const rows = await first.prisma.$queryRawUnsafe<Array<{ blocked: boolean }>>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))) AS blocked",
          holderPid,
        );
        blocked = rows[0]?.blocked === true;
      }
      expect(blocked).toBe(true);
      expect(closed).toBe(false);
    } finally {
      release();
      await Promise.all([held, writing, closing]);
    }
    await first.facts.raise(input);
    expect(await first.prisma.alertEvent.findFirstOrThrow()).toMatchObject({ occurrences: 2 });
    await second.facts.raise({ ...input, rule: "evidence.consent_digest_unavailable" });
    expect(await second.prisma.alertEvent.count()).toBe(2);
    await expect(first.facts.close()).resolves.toBeUndefined();
  });
});
