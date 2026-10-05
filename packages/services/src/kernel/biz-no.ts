// 业务单号（W0-13）：前缀表、格式规则、事务内取号。
// 依据：01 分组 第 2.2 节（biz_sequence、取号语句、前缀与位数表）；06 第 3.1 节；03 分组 第 2.12 节；14 分组 第 2.13 节。
//
//   1. 单号 = [T] + 前缀 + yyyyMMdd + 流水。业务日按北京时间，取注入的时钟；流水按“前缀 + 业务日”从 1 起。
//   2. 取号与业务写同事务：回滚时流水一并回滚，不产生空号。取号的行锁持有到提交，同前缀同日的取号因此串行；
//      biz_sequence 不参与锁排序，不过锁序断言。
//   3. 流水不足最少位数时左边补 0，超出自动扩位，不截断、不报错（11 种前缀都这样，任务书 第 11 节第 5 项）。
//   4. 预发环境的单号最前面加 T（11 种都加，任务书 第 11 节第 6 项）；biz_sequence.prefix 存不带 T 的前缀。
//      环境由装配注入，这里不读 process.env。
//   不经这里的三种：交付工单号 JF、授权书编号 SQ 由订购单号派生（各领域包），日志编号 RZ 由数据库序列生成。
import { calendarDate } from "@liyoxi/shared/time";
import type { LocalDate } from "@liyoxi/shared/time";

import type { Clock } from "./clock.js";
import type { AppEnv } from "./env.js";
import type { Tx } from "./tx.js";

/** 已登记的 11 种前缀与各自的最少流水位数（01 分组 第 2.2 节的表）。加前缀：先改那张表，再在这里加一行 */
export const BIZ_NO_MIN_DIGITS = {
  /** 订购单 */
  LYX: 5,
  /** 付款单 */
  FK: 5,
  /** 广告 */
  GG: 3,
  /** 客服工单 */
  KF: 3,
  /** 退款与取消（审批单取号） */
  TK: 3,
  /** 积分调整 */
  TZ: 3,
  /** 补偿延长 */
  YQ: 3,
  /** 账号变更 */
  ZH: 3,
  /** 开票申请 */
  KP: 3,
  /** 差异单 */
  CY: 3,
  /** 导出任务 */
  DC: 3,
} as const;

export type BizNoPrefix = keyof typeof BIZ_NO_MIN_DIGITS;

export const BIZ_NO_PREFIXES = Object.keys(BIZ_NO_MIN_DIGITS) as readonly BizNoPrefix[];

/** 预发环境的单号前缀 */
export const BIZ_NO_STAGING_MARK = "T";

export interface BizNoFormatOptions {
  /** 预发环境：最前面加 T */
  staging?: boolean;
}

/** 拼单号（纯函数）。bizDate 是北京时间的日历日期 YYYY-MM-DD；serial 是当日流水，从 1 起 */
export function formatBizNo(
  prefix: BizNoPrefix,
  bizDate: LocalDate,
  serial: number,
  { staging = false }: BizNoFormatOptions = {},
): string {
  if (!Object.hasOwn(BIZ_NO_MIN_DIGITS, prefix)) {
    throw new RangeError(`没有登记的单号前缀：${String(prefix)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate)) throw new RangeError(`业务日写法不对：${bizDate}`);
  if (!Number.isSafeInteger(serial) || serial < 1) throw new RangeError("流水要是正整数");
  const digits = String(serial).padStart(BIZ_NO_MIN_DIGITS[prefix], "0");
  return `${staging ? BIZ_NO_STAGING_MARK : ""}${prefix}${bizDate.replaceAll("-", "")}${digits}`;
}

export interface BizNoIssuerOptions {
  /** 业务日取它的“现在”，按北京时间取日 */
  clock: Clock;
  /** stg 下单号带 T */
  appEnv: AppEnv;
}

export interface BizNoIssuer {
  /** 在事务里取下一个单号。事务回滚，这个号就没发过 */
  next(tx: Tx, prefix: BizNoPrefix): Promise<string>;
}

/** 装配时建一次；各领域的服务函数拿它在自己的事务里取号 */
export function createBizNoIssuer({ clock, appEnv }: BizNoIssuerOptions): BizNoIssuer {
  const staging = appEnv === "stg";
  return {
    async next(tx, prefix) {
      if (!Object.hasOwn(BIZ_NO_MIN_DIGITS, prefix)) {
        throw new RangeError(`没有登记的单号前缀：${String(prefix)}`);
      }
      const bizDate = calendarDate(clock.now());
      // 照 01 分组 第 2.2 节 next_val 一行的原文：当日第一个号插入 next_val = 2，之后加一；返回值即本次取到的号
      const [row] = await tx.$queryRaw<{ serial: number }[]>`
        INSERT INTO biz_sequence (prefix, biz_date, next_val) VALUES (${prefix}, ${bizDate}::date, 2)
        ON CONFLICT (prefix, biz_date) DO UPDATE
          SET next_val = biz_sequence.next_val + 1, updated_at = now()
        RETURNING next_val - 1 AS serial`;
      if (!row) throw new Error("取号语句没有返回行");
      return formatBizNo(prefix, bizDate, row.serial, { staging });
    },
  };
}
