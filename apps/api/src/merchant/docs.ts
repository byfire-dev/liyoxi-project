// 共享的 docs 装配：处理器和商家服务取同一份，装配不反向依赖 routes。
import { createDocs } from "@liyoxi/services";
import type { Docs, Runtime } from "@liyoxi/services";
const built = new WeakMap<Runtime, Docs>();
export function docsOf(runtime: Runtime): Docs {
  let docs = built.get(runtime);
  if (docs === undefined) {
    docs = createDocs({ tx: runtime.tx, clock: runtime.clock });
    built.set(runtime, docs);
  }
  return docs;
}
