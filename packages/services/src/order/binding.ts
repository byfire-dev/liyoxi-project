import { AppError } from "../kernel/index.js";
import type { Assembly, Clock } from "../kernel/index.js";
import type { Flow } from "../flow/index.js";
import type { CancelDeps } from "./cancel-context.js";
export interface OrderBinding {
  readonly assembly: Assembly;
  readonly clock: Clock;
  readonly flow: Flow;
  readonly cancel?: CancelDeps;
}
const scopes: Array<{ binding: OrderBinding }> = [];
/** 静态登记的端口与自愈使用本进程依赖；解绑只撤销自身作用域，允许乱序关闭。 */
export function bindOrder(binding: OrderBinding): () => void {
  const scope = { binding };
  scopes.push(scope);
  return () => {
    const index = scopes.indexOf(scope);
    if (index >= 0) scopes.splice(index, 1);
  };
}
export function boundOrder(): OrderBinding {
  const scope = scopes.at(-1);
  if (!scope) throw new AppError("INTERNAL", { message: "order 同事务端口尚未绑定运行时" });
  return scope.binding;
}
