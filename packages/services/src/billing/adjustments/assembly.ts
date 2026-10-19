import { approvalKindPort } from "../../approval/index.js";
import type { Assembly, KeyedPort } from "../../kernel/index.js";
import type { BillingAdjustmentDeps } from "./context.js";
import { createAdjustmentKinds } from "./kinds.js";

/** 沿既有runtime assembly闭包装配两kind，不使用进程全局默认实例。 */
export function createAdjustmentAssembly(base: Assembly) {
  let deps: BillingAdjustmentDeps | undefined,
    closed = false;
  const kinds = createAdjustmentKinds(() => {
    if (closed || !deps) throw new TypeError("积分调整/补偿延长运行时尚未绑定或已关闭");
    return deps;
  });
  const entries = new Map([
    ["points_adjust", kinds.points],
    ["subscription_extend", kinds.extension],
  ]);
  for (const key of entries.keys())
    if (
      base.portImplementations.filter((item) => item.port === approvalKindPort && item.key === key)
        .length !== 1
    )
      throw new TypeError(`计费审批需要唯一${key}登记`);
  const assembly: Assembly = {
    ...base,
    portImplementations: base.portImplementations.map((item) =>
      item.port === approvalKindPort && item.key && entries.has(item.key)
        ? { ...item, impl: entries.get(item.key)! }
        : item,
    ),
    portEntries<T>(port: KeyedPort<T>) {
      const result = new Map(base.portEntries(port));
      if (port === approvalKindPort)
        for (const [key, value] of entries) result.set(key, value as T);
      return result;
    },
  };
  return {
    assembly,
    attach(value: BillingAdjustmentDeps) {
      if (closed || deps) throw new TypeError("计费审批运行时只能绑定一次");
      deps = value;
    },
    close() {
      closed = true;
      deps = undefined;
    },
  };
}
