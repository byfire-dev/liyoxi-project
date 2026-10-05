import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";

import { createClock, useTestDatabase } from "../testing/index.js";
import { BIZ_NO_MIN_DIGITS, BIZ_NO_PREFIXES, createBizNoIssuer, formatBizNo } from "./biz-no.js";
import type { BizNoPrefix } from "./biz-no.js";
import { createTxRunner } from "./tx.js";
import type { TxRunner } from "./tx.js";

// 验收第 9 条：11 种前缀各出一例、位数对；GG 第 1000 个是 4 位流水；过北京时间零点后流水从 1 起；预发环境带 T。
// 并发取号在 biz-no.concurrency.test.ts。

const db = useTestDatabase("services");
let prisma: PrismaClient;
let tx: TxRunner;

beforeAll(async () => {
  prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
}, 120_000);

const sequence = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await prisma.bizSequence.findMany()).map((row) => [
      `${row.prefix}@${row.bizDate.toISOString().slice(0, 10)}`,
      row.nextVal,
    ]),
  );

describe("业务单号：格式（纯函数）", () => {
  it("前缀表照 01 分组 第 2.2 节：11 种，LYX、FK 最少 5 位流水，其余 3 位", () => {
    expect(BIZ_NO_MIN_DIGITS).toEqual({
      LYX: 5,
      FK: 5,
      GG: 3,
      KF: 3,
      TK: 3,
      TZ: 3,
      YQ: 3,
      ZH: 3,
      KP: 3,
      CY: 3,
      DC: 3,
    });
    expect(BIZ_NO_PREFIXES).toHaveLength(11);
    // 库里 ck_biz_sequence_prefix 只收 2–4 个大写字母
    for (const prefix of BIZ_NO_PREFIXES) expect(prefix).toMatch(/^[A-Z]{2,4}$/);
  });

  it("不足最少位数补 0，超出自动扩位；预发在最前面加 T", () => {
    expect(formatBizNo("LYX", "2026-01-05", 1)).toBe("LYX2026010500001");
    expect(formatBizNo("FK", "2026-01-05", 99_999)).toBe("FK2026010599999");
    expect(formatBizNo("FK", "2026-01-05", 100_000)).toBe("FK20260105100000");
    expect(formatBizNo("GG", "2026-12-31", 999)).toBe("GG20261231999");
    expect(formatBizNo("GG", "2026-12-31", 1_000)).toBe("GG202612311000");
    expect(formatBizNo("DC", "2026-01-05", 7, { staging: true })).toBe("TDC20260105007");
  });

  it("没登记的前缀、写法不对的业务日、不是正整数的流水：抛 RangeError", () => {
    expect(() => formatBizNo("JF" as BizNoPrefix, "2026-01-05", 1)).toThrow(RangeError);
    expect(() => formatBizNo("toString" as BizNoPrefix, "2026-01-05", 1)).toThrow(RangeError);
    expect(() => formatBizNo("GG", "20260105", 1)).toThrow(RangeError);
    for (const serial of [0, -1, 1.5, Number.NaN]) {
      expect(() => formatBizNo("GG", "2026-01-05", serial), String(serial)).toThrow(RangeError);
    }
  });
});

describe("业务单号：事务内取号", () => {
  it("11 种前缀各取一个：前缀 + 8 位业务日 + 最少位数的流水，各自从 1 起", async () => {
    const issuer = createBizNoIssuer({ clock: createClock(), appEnv: "test" });
    const issued = await tx.run(async (handle) => {
      const numbers: Record<string, string> = {};
      for (const prefix of BIZ_NO_PREFIXES) numbers[prefix] = await issuer.next(handle, prefix);
      return numbers;
    });
    for (const prefix of BIZ_NO_PREFIXES) {
      const serial = "1".padStart(BIZ_NO_MIN_DIGITS[prefix], "0");
      expect(issued[prefix], prefix).toBe(`${prefix}20260105${serial}`);
    }
    // 接着取：同一事务里连取两个是连号；不同前缀互不影响
    expect(
      await tx.run(async (handle) => [
        await issuer.next(handle, "LYX"),
        await issuer.next(handle, "LYX"),
        await issuer.next(handle, "FK"),
      ]),
    ).toEqual(["LYX2026010500002", "LYX2026010500003", "FK2026010500002"]);
  });

  it("GG 第 999 个是 3 位流水，第 1000 个扩到 4 位", async () => {
    const clock = createClock(new Date("2026-02-01T04:00:00.000Z"));
    const issuer = createBizNoIssuer({ clock, appEnv: "test" });
    // 前 998 个已经发过：把下一个待发的流水号直接摆到 999，不真的取 998 次
    await prisma.bizSequence.create({
      data: { prefix: "GG", bizDate: new Date("2026-02-01"), nextVal: 999 },
    });
    expect(await tx.run((handle) => issuer.next(handle, "GG"))).toBe("GG20260201999");
    expect(await tx.run((handle) => issuer.next(handle, "GG"))).toBe("GG202602011000");
    expect((await sequence())["GG@2026-02-01"]).toBe(1_001);
  });

  it("业务日按北京时间：过零点后流水从 1 起；UTC 的日期还没变也算新的一天", async () => {
    // 北京时间 2026-03-09 23:59:59.999，UTC 是当天 15:59:59.999
    const clock = createClock(new Date("2026-03-09T15:59:59.999Z"));
    const issuer = createBizNoIssuer({ clock, appEnv: "test" });
    const take = (): Promise<string> => tx.run((handle) => issuer.next(handle, "KF"));
    expect([await take(), await take()]).toEqual(["KF20260309001", "KF20260309002"]);
    clock.advance(1);
    expect([await take(), await take()]).toEqual(["KF20260310001", "KF20260310002"]);
    expect(await sequence()).toMatchObject({ "KF@2026-03-09": 3, "KF@2026-03-10": 3 });
  });

  it("预发环境带 T；库里的 prefix 不带 T；别的环境不带", async () => {
    const clock = createClock(new Date("2026-04-01T04:00:00.000Z"));
    const take = (appEnv: "local" | "test" | "stg" | "prod", prefix: BizNoPrefix) =>
      tx.run((handle) => createBizNoIssuer({ clock, appEnv }).next(handle, prefix));
    expect(await take("stg", "FK")).toBe("TFK2026040100001");
    expect(await take("stg", "DC")).toBe("TDC20260401001");
    expect(await take("prod", "FK")).toBe("FK2026040100002");
    expect(await take("local", "FK")).toBe("FK2026040100003");
    expect(await sequence()).toMatchObject({ "FK@2026-04-01": 4, "DC@2026-04-01": 2 });
  });

  it("取号随事务回滚：回滚的事务不留空号，也不留行", async () => {
    const clock = createClock(new Date("2026-05-01T04:00:00.000Z"));
    const issuer = createBizNoIssuer({ clock, appEnv: "test" });
    const failed = new Error("业务失败");
    const rolledBack = tx.run(async (handle) => {
      expect(await issuer.next(handle, "TK")).toBe("TK20260501001");
      throw failed;
    });
    await expect(rolledBack).rejects.toBe(failed);
    expect(await sequence()).not.toHaveProperty("TK@2026-05-01");
    expect(await tx.run((handle) => issuer.next(handle, "TK"))).toBe("TK20260501001");
    await expect(
      tx.run(async (handle) => {
        await issuer.next(handle, "TK");
        throw failed;
      }),
    ).rejects.toBe(failed);
    expect(await tx.run((handle) => issuer.next(handle, "TK"))).toBe("TK20260501002");
  });

  it("没登记的前缀：抛 RangeError，一句 SQL 都不发", async () => {
    const issuer = createBizNoIssuer({ clock: createClock(), appEnv: "test" });
    const before = await sequence();
    await expect(tx.run((handle) => issuer.next(handle, "JF" as BizNoPrefix))).rejects.toThrow(
      RangeError,
    );
    expect(await sequence()).toEqual(before);
  });
});
