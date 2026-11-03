import type { Events } from "../events/index.js";
import type { Timers } from "../timers/index.js";
import type { PublishDeps } from "./context.js";
export interface PatrolDeps extends PublishDeps {
  events: Events;
  timers: Pick<Timers, "arm" | "cancel">;
}
export type PatrolFilter = {
  weekStartDate?: string;
  openOnly?: boolean;
  source?: string;
  storeId?: string;
  q?: string;
};
export type PatrolPage = PatrolFilter & {
  tab?: "all" | "pending" | "abnormal" | "normal";
  page: number;
  pageSize: number;
};
export type PatrolCheck = {
  checklistVersionNo: number;
  results: Array<{ key: string; result: "pass" | "fail" | "na"; note?: string }>;
  evidenceFileIds: string[];
};
export type PatrolAbnormal = Partial<Pick<PatrolCheck, "checklistVersionNo" | "results">> & {
  abnormalKindCode: string;
  note: string;
  evidenceFileIds: string[];
};
