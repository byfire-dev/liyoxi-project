// 故障注入之一：重复投递（W0-05b）。同一条消息投给处理函数 N 次，串行或并发。
//
// 用它验证“至少一次”语义下的处理函数是幂等的：出站事件的订阅者、定时器处理器、支付回调都会被重复投递。
// 每次投递给处理函数的是消息的一份深拷贝：真实的重复投递各自反序列化，处理函数改了入参不该影响下一次。
// 本文件只交工具；拿它去压内核的幂等是 W0-13、W0-20、W0-23 的事。

export interface RepeatedDeliveryOptions {
  /** 投几次（正整数） */
  times: number;
  /** serial：上一次处理完再投下一次；concurrent：N 次同时投出去 */
  mode: "serial" | "concurrent";
}

export interface RepeatedDelivery<T> {
  /** 每次投递的结果，按投递的先后 */
  results: Array<PromiseSettledResult<T>>;
  /** 成功的那几次的返回值 */
  fulfilled: T[];
  /** 失败的那几次抛出的错 */
  rejected: unknown[];
}

/**
 * 把同一条消息投给处理函数 times 次。处理函数抛错不会让它中断，错记在结果里。
 * @param handler 第二个参数是第几次投递（从 1 起）
 */
export async function deliverRepeatedly<M, T>(
  handler: (message: M, attempt: number) => T | Promise<T>,
  message: M,
  options: RepeatedDeliveryOptions,
): Promise<RepeatedDelivery<T>> {
  const { times, mode } = options;
  if (!Number.isInteger(times) || times < 1) throw new RangeError("times 要是正整数");
  if (mode !== "serial" && mode !== "concurrent") {
    throw new RangeError("mode 只能是 serial 或 concurrent");
  }
  // 包一层 async：处理函数同步抛的错也落成被拒的 Promise
  const deliver = async (attempt: number): Promise<T> => handler(structuredClone(message), attempt);

  let results: Array<PromiseSettledResult<T>>;
  if (mode === "concurrent") {
    // 同一个节拍里全部投出去，谁也不等谁
    results = await Promise.allSettled(Array.from({ length: times }, (_, i) => deliver(i + 1)));
  } else {
    results = [];
    for (let attempt = 1; attempt <= times; attempt += 1) {
      const [result] = await Promise.allSettled([deliver(attempt)]);
      if (result) results.push(result);
    }
  }
  return {
    results,
    fulfilled: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    rejected: results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  };
}
