import type { Tx } from "../kernel/index.js";
const passes = new WeakMap<object, { tx: Tx; id: string; operation: "enable" | "disable" }>();
export function issueStaffDisablePass(tx: Tx, id: string) {
  const pass = Object.freeze({});
  passes.set(pass, { tx, id, operation: "disable" });
  return pass;
}
export function acceptsStaffDisablePass(tx: Tx, id: string, value: unknown) {
  if (typeof value !== "object" || value === null) return false;
  const pass = passes.get(value);
  return pass?.tx === tx && pass.id === id && pass.operation === "disable";
}
export function issueStaffEnablePass(tx: Tx, id: string) {
  const pass = Object.freeze({});
  passes.set(pass, { tx, id, operation: "enable" });
  return pass;
}
export function acceptsStaffEnablePass(tx: Tx, id: string, value: unknown) {
  if (typeof value !== "object" || value === null) return false;
  const pass = passes.get(value);
  return pass?.tx === tx && pass.id === id && pass.operation === "enable";
}
