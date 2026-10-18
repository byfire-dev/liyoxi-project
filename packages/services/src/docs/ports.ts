// docs→media 同层调用通过纯依赖；组合根绑定当前 media 公口。
import type { StaffContext } from "../authz/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
export interface AgreementFileClaim {
  readonly id: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly etag: string | null;
  readonly sizeBytes: string | null;
  readonly sha256: string | null;
}
export interface AgreementFileInput {
  readonly identity: IdentityContext;
  readonly staff: StaffContext;
  readonly sourceFileId: string | null;
  readonly pdfFileId: string | null;
}
export interface PreparedAgreementContent {
  readonly sourceFileId: string | null;
  readonly pdfFileId: string | null;
  readonly contentHtml: string | null;
  readonly htmlSha256: string | null;
  readonly contentSha256: string | null;
  readonly similarityBp: number | null;
  readonly claims: readonly AgreementFileClaim[];
}
export interface AgreementFilePort {
  /** 已排序锁文件后重新验证当前权限/状态，prepare快照须完全一致。 */
  assertFiles(
    tx: Tx,
    input: AgreementFileInput,
    claims?: readonly AgreementFileClaim[],
  ): Promise<void>;
  link(tx: Tx, input: { fileId: string; versionId: string; role: "source" | "pdf" }): Promise<void>;
  release(
    tx: Tx,
    input: { fileId: string; versionId: string; role: "source" | "pdf"; keepUntil: Date },
  ): Promise<void>;
  /** 业务可见性由 docs 前后两次验证，Provider外呼只在TX外。 */
  signPdf(input: { fileId: string }): Promise<{ url: string; expiresAt: string }>;
  /** 内部先取得转换容量才读取对象；无文件不调用CPU/Storage。 */
  prepare(input: AgreementFileInput): Promise<PreparedAgreementContent>;
}
