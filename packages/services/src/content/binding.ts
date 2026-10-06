import type { Assembly } from "../kernel/index.js";
import { DramaPricePort } from "./ports.js";
let current: Pick<Assembly, "port"> | undefined;
/** 静态登记的 I1 取端口；业务工厂仍显式注入。作用域退出恢复前一份装配。 */
export function bindContent(assembly: Pick<Assembly, "port">): () => void {
  const previous = current;
  current = assembly;
  return () => {
    if (current === assembly) current = previous;
  };
}
export function boundContentPrices() {
  if (!current) throw new Error("content 不变量未绑定装配：启动时必须调用 bindContent");
  return current.port(DramaPricePort);
}
