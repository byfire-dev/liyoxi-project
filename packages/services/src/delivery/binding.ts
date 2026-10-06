import type { DeliveryCoreDeps } from "./context.js";
const scopes: Array<{ deps: DeliveryCoreDeps }> = [];
/** API 与真实 worker 都装配；每个清理函数只撤销自己的作用域，允许乱序停止。 */
export function bindDelivery(deps: DeliveryCoreDeps) {
  const scope = { deps };
  scopes.push(scope);
  return () => {
    const i = scopes.indexOf(scope);
    if (i >= 0) scopes.splice(i, 1);
  };
}
export function boundDelivery() {
  const scope = scopes.at(-1);
  if (!scope) throw new Error("delivery 同事务端口尚未绑定运行时");
  return scope.deps;
}
