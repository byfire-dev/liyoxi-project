// W1-21：仅接口合流/演示使用的无 Vitest 支架边界。业务写仍只走生产 API。
import type { Runtime } from "../runtime.js";
import type { DemoSeedReport } from "../demo-seed.js";
import type { InvariantRunResult } from "../ops/index.js";
import type { ChecklistCode, ChecklistTemplateView } from "../config/index.js";
import type { FakeProviders } from "./providers/index.js";
import type { AdjustableClock } from "./clock.js";
import type { M1_PROFILE_DEFAULTS } from "./m1-profile-defaults.js";
import type { M1StateIds, readM1State } from "./m1-state.js";
import type { Redis } from "ioredis";
import type { ModelBudgetTransport } from "../media/index.js";
import type { createMinioStorage, PresignedPost } from "../providers/index.js";

export interface M1HttpObjectIO {
  upload(post: PresignedPost, bytes: Uint8Array): Promise<number>;
  readSigned(url: string): Promise<ReturnType<FakeProviders["storage"]["fetch"]>>;
}

/** 只由原资源拥有者在内存/0600任务文件中交给本轮镜像；不得进入公开报告。 */
export interface M1SharedScope {
  readonly runId: string;
  readonly databaseName: string;
  readonly redisPrefix: string;
  readonly ownerToken: string;
  readonly startedAt: string;
}
export interface M1Attachment {
  readonly scope: M1SharedScope;
  readonly chainId: string;
  readonly version: string;
  readonly storage: NonNullable<Parameters<typeof createMinioStorage>[0]>;
}

export interface M1OwnerNetworkIdentity {
  readonly runId: string;
  readonly source: string;
  readonly nonce: string;
  readonly networkId: string;
}
/** controller 已核实际 Docker 身份后的私有收据；不是支架自行认证网络。 */
export interface M1OwnerNetwork {
  readonly expected: M1OwnerNetworkIdentity;
  readonly receipt: M1OwnerNetworkIdentity & {
    readonly schemaVersion: 1;
    readonly containers: {
      readonly postgres: string;
      readonly redis: string;
      readonly minio: string;
    };
  };
}

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
  /** 仅受保护 attach 装配；真实对象 IO 与对应版本 worker 共用同一 MinIO 客户端。 */
  readonly httpIO?: M1HttpObjectIO;
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
  readonly productionVideo: M1Support["video"];
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
  finishProduction(fileId: string, scope: M1MediaScope): Promise<void>;
  fullInvariants(): Promise<InvariantRunResult>;
  close(): Promise<void>;
  /** 只导出本轮随机库能力；attach实例关闭只关连接，资源仍由原拥有者清理。 */
  sharedScope(): M1SharedScope;
}
export interface M1SupportOptions {
  readonly attach?: M1Attachment;
  /** 仅 test/nonattach owner：本轮固定私网、正式迁移补种、实钟；不进公开报告。 */
  readonly ownerNetwork?: M1OwnerNetwork;
  /** 私有 RPC 的诊断出口；缺省保留原 stdout。调用方不得转印日志原文。 */
  readonly diagnosticWrite?: (line: string) => void;
  /** HTTP 桥自有生命周期；默认 M1 不注入。 */
  readonly signal?: AbortSignal;
  /** 仅受保护attach：独立worker运输，支架只观察，不认领/直接运行handler。 */
  readonly backgroundWorker?: { readonly resumeTimerScan: () => Promise<void> };
  /** 本轮随机 1–12 位小写字母数字；缺省随机生成，不复用别人的库/Redis 前缀。 */
  readonly runId?: string;
  readonly clock?: AdjustableClock;
  /** 测试外部 IO 预置；缺省不改变既有 M1 替身。 */
  readonly prepareProviders?: (providers: FakeProviders) => void;
  /** 只借用同一隔离支架的连接；由原 close 回收，缺省仍不装配模型预算传输。 */
  readonly modelBudgetTransport?: (input: {
    readonly redis: Redis;
    readonly clock: AdjustableClock;
    readonly redisPrefix: string;
  }) => Promise<ModelBudgetTransport>;
}
