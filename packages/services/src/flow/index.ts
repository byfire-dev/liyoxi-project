// flow：统一状态迁移（W0-16）。用法见本目录的 README.md。
export { createFlow } from "./runtime.js";
export type { AdminFlow, Flow, FlowOptions } from "./runtime.js";
export type {
  MergedAudit,
  AdminStaffFact,
  AdminStaffReader,
  AdminTransitionInput,
  NoEvent,
  TransitionEvent,
  TransitionInput,
  TransitionKeys,
  TransitionResult,
} from "./transition.js";
export { FlowError } from "./errors.js";
export type { FlowRefusal } from "./errors.js";
export {
  chainKey,
  machinePort,
  NO_ACTIVITY_MACHINES,
  rowKey,
  UNREGISTERED_WORK_MINUTES,
  WORK_MINUTE_MACHINES,
  workMinutesPort,
} from "./bindings.js";
export type {
  ActivityDescription,
  ChainRef,
  Effect,
  Guard,
  MachineBinding,
  TransitionFacts,
  WorkMinutes,
} from "./bindings.js";
export {
  assertStateColumns,
  findI12Violations,
  findMissingStateColumns,
  I12_MAX_VIOLATIONS,
} from "./invariants.js";
export { registration } from "./register.js";
