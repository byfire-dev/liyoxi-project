import type { Assembly } from "../kernel/index.js";
const scopes: Array<{ assembly: Assembly }> = [];
export function bindPublish(assembly: Assembly) {
  const scope = { assembly };
  scopes.push(scope);
  return () => {
    const i = scopes.indexOf(scope);
    if (i >= 0) scopes.splice(i, 1);
  };
}
export function boundAssembly() {
  const scope = scopes.at(-1);
  if (!scope) throw new Error("publish 读处理人端口未绑定装配");
  return scope.assembly;
}
