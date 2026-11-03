import type { TransitionFacts } from "../flow/index.js";
import type { Tx } from "../kernel/index.js";
const authority = new WeakMap<Tx, ReadonlySet<string>>();
const pass = Symbol("publish.launch_revoke");

export async function withLaunchRevokePatrols<T>(
  tx: Tx,
  ids: readonly string[],
  write: (args: symbol) => Promise<T>,
) {
  if (authority.has(tx)) throw new TypeError("撤销核验清理不可嵌套");
  authority.set(tx, new Set(ids));
  try {
    return await write(pass);
  } finally {
    authority.delete(tx);
  }
}
export const launchRevokePatrolGuard = async (tx: Tx, facts: TransitionFacts) =>
  facts.args === pass &&
  facts.event === "patrol.void" &&
  (authority.get(tx)?.has(facts.subjectId) ?? false);
