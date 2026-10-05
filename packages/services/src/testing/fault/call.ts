// 故障注入之四：外部调用前、中、后中断（W0-05b）。包住一次外部调用，在三个断点之一让它断掉。
//
//   before  调用还没发出去就断了：外部一侧什么都没收到。
//   during  调用发出去了、应答还没回来就断了：调用方立刻拿到错，外部一侧照常处理完（结果被丢弃）。
//           调用方分不清对方处理了没有——超时、连接中断就是这种情形。用 inFlight() 等外部一侧处理完。
//   after   应答已经回来、调用方还没来得及用它就断了：外部一侧已处理，应答挂在错误的 result 上。
//
// “先调外部、再开事务”的写法（01 第 5 节）要在这三处都经得住重试；本文件只交工具，
// 拿它去压三段式是 W0-20 的事。要的是进程真的死掉而不是抛错时，把它与 crashPoint 搭着用。

export type InterruptPoint = "before" | "during" | "after";

export const INTERRUPT_POINTS: readonly InterruptPoint[] = ["before", "during", "after"];

/** 被注入的中断。point 是断在哪；after 时 result 是外部调用的应答 */
export class CallInterruptedError extends Error {
  readonly point: InterruptPoint;
  readonly result: unknown;

  constructor(point: InterruptPoint, result?: unknown) {
    super(`注入的中断：外部调用${{ before: "之前", during: "当中", after: "之后" }[point]}`);
    this.name = "CallInterruptedError";
    this.point = point;
    this.result = result;
  }
}

export interface CallInterrupter {
  /** 让接下来的调用在 point 处中断；缺省一次，times 可以给多次。可以连着布置几个，按先后用掉 */
  arm(point: InterruptPoint, options?: { times?: number }): void;
  /** 执行一次外部调用。布置了中断就在对应的断点抛 CallInterruptedError，没布置就原样执行 */
  call<T>(external: () => T | Promise<T>): Promise<T>;
  /** 把一个函数包成同签名的函数，每次调用都经 call */
  wrap<A extends unknown[], T>(
    external: (...args: A) => T | Promise<T>,
  ): (...args: A) => Promise<T>;
  /** 已经触发的中断，按先后 */
  readonly fired: readonly InterruptPoint[];
  /** 布置了还没用掉的中断数 */
  pending(): number;
  /** 等 during 中断留下的、还在外部一侧处理的调用全部结束（成败都算结束） */
  inFlight(): Promise<void>;
}

export function createCallInterrupter(): CallInterrupter {
  const armed: InterruptPoint[] = [];
  const fired: InterruptPoint[] = [];
  const flying = new Set<Promise<unknown>>();

  async function call<T>(external: () => T | Promise<T>): Promise<T> {
    const point = armed.shift();
    if (point === undefined) return external();
    fired.push(point);
    if (point === "before") throw new CallInterruptedError(point);
    if (point === "during") {
      // 调用照发，调用方不等它
      const pending = Promise.resolve()
        .then(external)
        .catch(() => {})
        .finally(() => flying.delete(pending));
      flying.add(pending);
      throw new CallInterruptedError(point);
    }
    throw new CallInterruptedError(point, await external());
  }

  return {
    arm(point, options = {}) {
      if (!INTERRUPT_POINTS.includes(point)) {
        throw new RangeError("断点只能是 before、during、after");
      }
      const times = options.times ?? 1;
      if (!Number.isInteger(times) || times < 1) throw new RangeError("times 要是正整数");
      for (let count = 0; count < times; count += 1) armed.push(point);
    },
    call,
    wrap:
      (external) =>
      (...args) =>
        call(() => external(...args)),
    fired,
    pending: () => armed.length,
    async inFlight() {
      while (flying.size > 0) await Promise.allSettled([...flying]);
    },
  };
}
