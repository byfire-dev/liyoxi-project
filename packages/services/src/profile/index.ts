export { createProfile } from "./service.js";
export type { Profile } from "./service.js";
export type { ProfileDeps, ProfileViewer, WriteOptions } from "./context.js";
export { storeGate, assertProfileComplete, industryOpen, storeLocation } from "./gate.js";
export type { StoreGate } from "./gate.js";
export { orderManagerPort, deliveryManagerPort } from "./ports.js";
export type { ManagerAssignment, SyncStoreManager } from "./ports.js";
export { findViolations, PROFILE_INVARIANT_CODES } from "./invariants.js";
export { registration } from "./register.js";
