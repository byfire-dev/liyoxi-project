// 商家端：套餐、积分、付款与发票 · point-ledger-entries（docs/api/m07-billing.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantRoute } from "../builders.js";
import { z } from "../../zod.js";
import {
  DateSchema,
  InstantSchema,
  MonthSchema,
  okResponse,
  errorResponses,
} from "../../common/index.js";
export const MerchantLedgerQuerySchema = z.object({
  tab: z.enum(["all", "gain", "use", "expire"]).default("all"),
  month: MonthSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const MerchantLedgerRowSchema = z.object({
  rowKey: z.string(),
  category: z.enum(["gain", "use", "expire", "other"]),
  opType: z.string(),
  lotKind: z.enum(["plan", "addon"]).nullable(),
  deltaPoints: z.int(),
  occurredAt: InstantSchema,
  bizDate: DateSchema,
  title: z.string(),
  remark: z.string().nullable(),
  formula: z.string().nullable(),
  storeName: z.string().nullable(),
  refNo: z.string().nullable(),
  itemCount: z.int().positive(),
  holdStatus: z.string().nullable(),
});
export const MerchantLedgerPageSchema = z.object({
  items: z.array(MerchantLedgerRowSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  month: MonthSchema,
  prevMonth: MonthSchema.nullable(),
  firstEntryAt: InstantSchema.nullable(),
});
export type MerchantLedgerQuery = z.infer<typeof MerchantLedgerQuerySchema>;
export type MerchantLedgerRow = z.infer<typeof MerchantLedgerRowSchema>;

export const mPointLedgerEntryList = merchantRoute({
  request: { query: MerchantLedgerQuerySchema },
  responses: { ...okResponse(MerchantLedgerPageSchema), ...errorResponses(400, 401, 403, 404) },
  method: "get",
  path: "/m/point-ledger-entries",
  operationId: "m.pointLedgerEntry.list",
  summary:
    "积分明细（?tab=all|gain|use|expire&month=YYYY-MM，默认当月，逐月加载）：标题、积分来源、时间、门店与关联单号、计算式备注、数量；响应带 prevMonth 与 firstEntryAt",
  "x-capability": "ledger.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
