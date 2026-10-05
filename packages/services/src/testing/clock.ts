// 可拨时钟（W0-05b）。借自参考工程 packages/services/src/testing/index.ts 的 createClock：now、advance、set。
//
// 业务时间只取注入的时钟（01 第 5 节调用规则 4；06 第 3.2 节），测试里注入这一个：不拨就不走。
// 形状是 { now(): Date } 加 advance、set；kernel 的 Clock 接口由 W0-07 定义，与这里同形。
// W0-19 的十二个替身只用到 now()，这只时钟可以直接传给 createFakeProviders({ clock })。

export interface AdjustableClock {
  /** 现在几点。每次返回一个新的 Date，改它不影响时钟 */
  now(): Date;
  /** 往前拨 ms 毫秒（非负整数） */
  advance(ms: number): void;
  /** 直接拨到某个时刻，可以往回拨 */
  set(to: Date): void;
}

/** 缺省的起点：2026-01-05 12:00（北京时间，周一）。要别的时刻就传进来或用 set */
export const DEFAULT_CLOCK_START = "2026-01-05T04:00:00.000Z";

export function createClock(start: Date = new Date(DEFAULT_CLOCK_START)): AdjustableClock {
  const check = (at: Date): number => {
    const ms = at instanceof Date ? at.getTime() : Number.NaN;
    if (Number.isNaN(ms)) throw new RangeError("时钟只接受合法的 Date");
    return ms;
  };
  let current = check(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) {
        throw new RangeError("advance 只接受非负整数毫秒；要往回拨用 set");
      }
      current += ms;
    },
    set(to) {
      current = check(to);
    },
  };
}
