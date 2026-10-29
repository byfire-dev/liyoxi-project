// 组合根：各领域服务保留唯一写入口，应用返回同一取消资源上的九个读写方法及执行。
import type { CancelRequestFilters, CancelRequestListQuery } from "@liyoxi/contract";
import {
  createCancelExecution,
  createCancelRequests,
  listCancelRequests,
  readCancelRequestDetail,
  summarizeCancelRequests,
} from "./order/index.js";
import type { CancelActor, CancelDeps } from "./order/index.js";

export function createRuntimeCancelRequests(deps: CancelDeps) {
  return {
    ...createCancelExecution(deps),
    ...createCancelRequests(deps),
    get: (actor: CancelActor, id: string) =>
      deps.tx.run((tx) => readCancelRequestDetail(tx, deps, actor, id)),
    list: (actor: CancelActor, query: CancelRequestListQuery) =>
      deps.tx.run((tx) => listCancelRequests(tx, deps, actor, query)),
    summary: (actor: CancelActor, query: CancelRequestFilters) =>
      deps.tx.run((tx) => summarizeCancelRequests(tx, deps, actor, query)),
  };
}
export type RuntimeCancelRequests = ReturnType<typeof createRuntimeCancelRequests>;
