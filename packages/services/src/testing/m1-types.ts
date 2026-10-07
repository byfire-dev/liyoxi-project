// W1-21：仅接口合流/演示使用的无 Vitest 支架边界。业务写仍只走生产 API。
import type { Runtime } from "../runtime.js";
import type { DemoSeedReport } from "../demo-seed.js";
import type { InvariantRunResult } from "../ops/index.js";
import type { ChecklistCode, ChecklistTemplateView } from "../config/index.js";
import type { FakeProviders } from "./providers/index.js";
import type { AdjustableClock } from "./clock.js";
import type { M1_PROFILE_DEFAULTS } from "./m1-profile-defaults.js";
import type { M1StateIds, readM1State } from "./m1-state.js";

export interface M1OrderScope {
  readonly entityId: string;
  readonly storeId: string;
  readonly orderId: string;
  readonly merchantUserId: string;
}
export interface M1Scope extends M1OrderScope {
  readonly orderItemId: string;
  readonly deliveryTicketId: string;
}
export interface M1MediaScope extends M1Scope {
  readonly uploaderId: string;
  readonly category: "sample_video" | "final_episode";
  readonly episodeNo?: number;
}
export type { M1StateIds } from "./m1-state.js";

export interface M1Support {
  readonly runId: string;
  readonly databaseName: string;
  readonly redisPrefix: string;
  readonly runtime: Runtime;
  readonly clock: AdjustableClock;
  readonly providers: FakeProviders;
  readonly profileDefaults: typeof M1_PROFILE_DEFAULTS;
  readonly video: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly durationMs: number;
    readonly width: number;
    readonly height: number;
    readonly videoCodec: string;
    readonly hasAudio: boolean;
  };
  seedDemo(): Promise<DemoSeedReport>;
  checklist(code: ChecklistCode): Promise<ChecklistTemplateView>;
  readState(ids: M1StateIds): ReturnType<typeof readM1State>;
  orderTimer(scope: M1OrderScope): Promise<{ readonly timerId: string; readonly fireAt: Date }>;
  runDueTimer(
    scope: M1OrderScope,
    timerId: string,
  ): Promise<{
    readonly outcome: "fired";
    readonly dispatchNo: number;
    readonly fireAt: Date;
    readonly businessNow: Date;
  }>;
  drainEvents(): Promise<{ readonly expanded: number; readonly consumed: number }>;
  promote(fileId: string): Promise<void>;
  installKnownMedia(fileId: string, scope: M1MediaScope): Promise<void>;
  fullInvariants(): Promise<InvariantRunResult>;
  close(): Promise<void>;
}
export interface M1SupportOptions {
  /** 本轮随机 1–12 位小写字母数字；缺省随机生成，不复用别人的库/Redis 前缀。 */
  readonly runId?: string;
  readonly clock?: AdjustableClock;
}
