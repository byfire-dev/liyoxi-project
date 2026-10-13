import type { FileObject } from "@liyoxi/db";
import type { UploadCategory } from "@liyoxi/shared/uploads";
import type { Events } from "../events/index.js";
import type {
  Assembly,
  Clock,
  IdempotencyContext,
  QueueChannel,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import type { WechatProvider, MediaProvider, StorageProvider } from "../providers/types.js";
import type { MediaJobHandler, MediaConvergenceHandler } from "./jobs/types.js";
import type { MediaProductionDeps } from "./production-types.js";
import type { FileRefType } from "../kernel/index.js";
import type { MediaBatchDeps } from "./batches/types.js";
import type { MediaAssetsDeps } from "./assets/types.js";
import type { MediaActor } from "./actor.js";
import type { RetentionOptions } from "./retention/options.js";
export type FileRow = FileObject;
export type { MediaActor } from "./actor.js";
export interface FileCategoryGuard {
  assert(tx: Tx, actor: MediaActor, input: RegisterInput): Promise<void>;
  registered?(tx: Tx, fileId: string, actor: MediaActor, input: RegisterInput): Promise<void>;
}
export interface MediaDeps {
  readonly retention?: RetentionOptions;
  readonly assets?: MediaAssetsDeps;
  readonly batches?: MediaBatchDeps;
  readonly production?: MediaProductionDeps;
  readonly jobOwnerId?: string;
  readonly jobHandlers?: readonly MediaJobHandler[];
  readonly jobConvergenceHandlers?: readonly MediaConvergenceHandler[];
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly storage: StorageProvider;
  readonly events: Pick<Events, "emit">;
  readonly assembly: Pick<Assembly, "portEntries">;
  readonly channel?: Pick<QueueChannel, "enqueue">;
  readonly videoMaxMb?: () => Promise<number>;
  readonly pollMs?: number;
  readonly moderation?: MediaProvider;
  readonly wechatImage?: {
    readonly appid?: string;
    readonly provider: Pick<WechatProvider, "checkImage" | "configured">;
    readonly fallback: Pick<MediaProvider, "audit" | "status">;
    readonly recentWechatOpenid: (
      tx: Tx,
      input: { merchantUserId: string; appid: string; now: Date },
    ) => Promise<{ wechatIdentityId: string; openid: string } | null>;
  };
}
export interface BoundMediaDeps extends MediaDeps {
  readonly queueBatchProbe?: (tx: Tx, fileId: string, batchId: string) => Promise<string>;
  readonly batchStored?: (tx: Tx, fileId: string) => Promise<void>;
  readonly batchRejected?: (tx: Tx, fileId: string) => Promise<void>;
  readonly queueProbe?: (tx: Tx, file: FileRow) => Promise<string | null>;
  readonly refTypes: ReadonlyMap<string, FileRefType>;
  readonly guards: ReadonlyMap<string, FileCategoryGuard>;
}
export type BatchRuntimeDeps = BoundMediaDeps & { readonly batches: MediaBatchDeps };
export interface UploadInput {
  readonly fileName: string;
  readonly sizeBytes: string;
  readonly clientToken: string;
}
export interface RegisterInput {
  readonly category: UploadCategory;
  readonly files: readonly UploadInput[];
  readonly licenseKind?: "business_license" | "branch_license";
  readonly entityId?: string;
  readonly storeId?: string;
  readonly onBehalfStore?: boolean;
  readonly production?: unknown;
}
export interface MediaOptions {
  readonly idem?: IdempotencyContext;
}
export interface FileOwnerScope {
  readonly entityId: string | null;
  readonly storeId: string | null;
}
export interface LinkInput extends FileOwnerScope {
  readonly fileId: string;
  readonly refType: string;
  readonly refId: string;
  readonly role: string;
  readonly released?: boolean;
  readonly keepUntil?: Date;
}
export interface ReleaseInput extends FileOwnerScope {
  readonly fileId: string;
  readonly refType: string;
  readonly refId: string;
  readonly role: string;
  readonly keepUntil: Date;
}
export type RefRetentionInput = Pick<
  ReleaseInput,
  "fileId" | "refType" | "refId" | "role" | "entityId" | "storeId"
>;
export type RefRetention =
  | { readonly state: "live"; readonly releasedAt: null; readonly keepUntil: null }
  | { readonly state: "released"; readonly releasedAt: Date; readonly keepUntil: Date };
export interface ReadSignInput {
  readonly fileId: string;
  readonly disposition?: "inline" | "attachment";
  readonly audience?: "staff" | "merchant";
}
/** 交付下载的技术签名口；调用域先判业务授权，并从可信领域事实生成附件名。 */
export interface DeliveryDownloadSignInput {
  readonly fileId: string;
  readonly fileName: string;
}
export interface SystemFileInput extends FileOwnerScope {
  readonly category: UploadCategory;
  readonly fileName: string;
  readonly body: Uint8Array;
  /** 调用方给稳定、全小写 ASCII 的正式区键。只供系统种子/生成用例。 */
  readonly objectKey: string;
}
export type FileReader = Pick<Tx, "fileObject" | "fileRef" | "store" | "staff" | "merchantUser">;
