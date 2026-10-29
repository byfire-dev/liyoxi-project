import { AppError } from "../kernel/index.js";
import type { CancelDeps } from "./cancel-context.js";

const bindings: CancelDeps[] = [];
export const currentCancelRequests = () => bindings.at(-1);
/** Worker subscribers consume the same real cancellation dependencies as the API. */
export function bindCancelRequests(deps: CancelDeps): () => void {
  bindings.push(deps);
  return () => {
    const index = bindings.indexOf(deps);
    if (index >= 0) bindings.splice(index, 1);
  };
}
export function boundCancelRequests(): CancelDeps {
  const deps = currentCancelRequests();
  if (!deps) throw new AppError("INTERNAL", { message: "取消申请尚未绑定运行时" });
  return deps;
}
