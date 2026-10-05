// audit_log 三个 jsonb 列的结构（W0-14；03 分组文档 第 4 节）：AuditDiff（before、after）、AuditMeta（meta）。
// 写入方是 services 的 audit.record：它先清洗、脱敏再写，不拿这里的 schema 去拦内容（record 永不因内容格式失败）。
// 这里的 schema 给读的一侧用：审计查询与导出的响应（G2-A）。
import { z } from "../zod.js";

/** 序列化后超过 16KB 时改存的摘要：顶层键名、字节数、sha256（十六进制小写） */
export const AuditJsonDigestSchema = z
  .object({
    keys: z.array(z.string()),
    length: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .openapi("AuditJsonDigest");
export type AuditJsonDigest = z.infer<typeof AuditJsonDigestSchema>;

/**
 * before、after：只含发生变化的字段，键是字段名、值是脱敏后的值；不含口令、令牌、动态码密钥。
 * 超过 16KB 时是摘要
 */
export const AuditDiffSchema = z
  .union([AuditJsonDigestSchema, z.record(z.string(), z.unknown())])
  .openapi("AuditDiff");
export type AuditDiff = z.infer<typeof AuditDiffSchema>;

/** meta 里已知的键；别的键照收。各域加已知的键时往这里加，同 PR 改 03 分组文档 第 4 节 */
const AuditMetaFieldsSchema = z.looseObject({
  /** 审批状态 */
  approvalStatus: z.string().optional(),
  /** 业务单号 */
  requestNo: z.string().optional(),
  /** 命中的规则 */
  rule: z.string().optional(),
  /** 通知结果 */
  notify: z.unknown().optional(),
  /** 影响范围，如移交数量 */
  impact: z.unknown().optional(),
  batchId: z.string().optional(),
  /** 代某员工执行的导出 */
  onBehalfOfStaffId: z.string().optional(),
  /** access 流的文件读地址：文件分类与地址有效期（秒） */
  fileCategory: z.string().optional(),
  urlTtlSec: z.number().int().optional(),
  /** 导出完成：行数与文件摘要 */
  rowCount: z.number().int().optional(),
  fileSha256: z.string().optional(),
});
/** 写入方给 meta 的形状 */
export type AuditMetaFields = z.infer<typeof AuditMetaFieldsSchema>;

/** meta：扩展键值；超过 16KB 时是摘要 */
export const AuditMetaSchema = z
  .union([AuditJsonDigestSchema, AuditMetaFieldsSchema])
  .openapi("AuditMeta");
export type AuditMeta = z.infer<typeof AuditMetaSchema>;
