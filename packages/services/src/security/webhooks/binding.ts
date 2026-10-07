import type { Webhooks } from "./types.js";

const scopes: Array<{ webhooks: Webhooks }> = [];
export function bindWebhooks(webhooks: Webhooks): () => void {
  const scope = { webhooks };
  scopes.push(scope);
  return () => {
    const index = scopes.indexOf(scope);
    if (index >= 0) scopes.splice(index, 1);
  };
}
export function boundWebhooks(): Webhooks {
  const scope = scopes.at(-1);
  if (!scope) throw new Error("回调框架未绑定实际运行时");
  return scope.webhooks;
}
