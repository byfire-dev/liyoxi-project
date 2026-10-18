// 后台：套餐积分与财务 · point-accounts（docs/api/a07-billing-finance.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { z } from "../../zod.js";
import {
  IdSchema,
  DateSchema,
  InstantSchema,
  PageQuerySchema,
  okResponse,
  errorResponses,
} from "../../common/index.js";
import { adminPage, adminCursorPage, AdminCursorQuerySchema } from "../a01-system/structures.js";
import { PaymentOrderAdminDetailSchema } from "./purchase.schemas.js";
import { POINT_ADJUSTMENT_REQUEST_REASON_CODE } from "../../enums/index.js";
import { zodEnum } from "../../enums/zod.js";

const count = z.int().nonnegative();
const store = z.object({ storeId: IdSchema, name: z.string() });
export const PointAccountParamsSchema = z.object({ pointAccountId: IdSchema });
export const PointAccountFilterSchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  planId: IdSchema.optional(),
  subStatus: z.enum(["none", "active", "expired"]).optional(),
  flag: z.enum(["has_held", "expiring_7d", "refund_pending"]).optional(),
});
export const PointAccountListQuerySchema = PointAccountFilterSchema.extend({
  ...PageQuerySchema.shape,
  sort: z.enum(["-spendablePoints", "planPointsExpireAt", "-updatedAt"]).default("-updatedAt"),
});
export const PointAccountRowSchema = z.object({
  pointAccountId: IdSchema,
  entity: PaymentOrderAdminDetailSchema.shape.entity,
  subscription: z.object({
    status: z.enum(["none", "active", "expired"]),
    plan: z.object({ planId: IdSchema, name: z.string() }).nullable(),
    months: count.nullable(),
    startDate: DateSchema.nullable(),
    endDate: DateSchema.nullable(),
    endsAt: InstantSchema.nullable(),
    upgradedFrom: z.object({ planName: z.string(), at: InstantSchema }).nullable(),
  }),
  planAvailablePoints: count,
  planPointsExpireAt: InstantSchema.nullable(),
  addonAvailablePoints: count,
  isAddonSuspended: z.boolean(),
  heldPoints: count,
  spendablePoints: count,
  isRefundPending: z.boolean(),
  hasPendingAdjustment: z.boolean(),
});
export const PointAccountPageSchema = adminPage(PointAccountRowSchema);
export const PointAccountSummarySchema = z.object({
  accountCount: count,
  activeAccountCount: count,
  balancePoints: count,
  heldPoints: count,
  grantedThisMonthPoints: count,
  consumedThisMonthPoints: count,
});
export const PendingBillingCancelSchema = z.object({
  cancelRequestId: IdSchema,
  requestNo: z.string().nullable(),
  kind: z.string(),
  targetNo: z.string(),
  refundPoints: count,
  status: z.string(),
});
export const PointAccountDetailSchema = PointAccountRowSchema.extend({
  currentTerm: z
    .object({
      subscriptionTermId: IdSchema,
      termNo: z.int().positive(),
      planName: z.string(),
      months: z.int().positive(),
      startDate: DateSchema,
      endDate: DateSchema,
      endsAt: InstantSchema,
      extendedDays: count,
      benefits: z.object({
        discountBp: count,
        monthlyPoints: count,
        productionModel: z.string(),
        maxStores: count,
        maxMembers: count.nullable(),
      }),
    })
    .nullable(),
  scheduledTerms: z.array(
    z.object({
      subscriptionTermId: IdSchema,
      planName: z.string(),
      months: z.int().positive(),
      startDate: DateSchema,
      endDate: DateSchema,
    }),
  ),
  planGrantedThisTerm: count,
  lastExpired: z.object({ points: count, at: InstantSchema }).nullable(),
  notices: z.object({
    pendingRefund: z
      .object({ refundRequestId: IdSchema, requestNo: z.string().nullable(), status: z.string() })
      .nullable(),
    pendingAdjustment: z
      .object({
        pointAdjustmentRequestId: IdSchema,
        requestNo: z.string().nullable(),
        direction: z.enum(["increase", "decrease"]),
        lotKind: z.enum(["plan", "addon"]),
        adjustPoints: count,
      })
      .nullable(),
    pendingExtension: z
      .object({ termExtensionRequestId: IdSchema, requestNo: z.string().nullable(), days: count })
      .nullable(),
    pendingCancels: z.array(PendingBillingCancelSchema),
    heldAwaitingQualification: z.array(
      z.object({ pointHoldId: IdSchema, groupRef: z.string().nullable(), qty: count, store }),
    ),
  }),
  actions: z.array(z.literal("create-point-adjustment-request")),
});
export const PointAdjustmentInputSchema = z
  .strictObject({
    direction: z.enum(["increase", "decrease"]),
    lotKind: z.enum(["plan", "addon"]),
    adjustPoints: z.int().positive(),
    reasonCode: zodEnum(POINT_ADJUSTMENT_REQUEST_REASON_CODE),
    pointHoldId: IdSchema.optional(),
  })
  .refine(
    (x) => x.reasonCode !== "platform_refund" || (x.direction === "increase" && !!x.pointHoldId),
    { message: "平台原因退回只能增加且必须关联冻结单", path: ["pointHoldId"] },
  );
export const PointAdjustmentQuoteSchema = z.object({
  spendableBeforePoints: count,
  spendableAfterPoints: count,
  lotAvailableBefore: count,
  lotAvailableAfter: count,
  planPointsExpireAt: InstantSchema.nullable(),
  pointHold: z
    .object({
      pointHoldId: IdSchema,
      groupRef: z.string().nullable(),
      qty: count,
      returnablePoints: count,
      status: z.string(),
    })
    .nullable(),
  isAllowed: z.boolean(),
  blockReasons: z.array(
    z.enum(["account_inactive", "insufficient", "hold_invalid", "pending_exists"]),
  ),
});
export const AccountLedgerQuerySchema = AdminCursorQuerySchema.extend({
  tab: z.enum(["all", "gain", "use", "expire"]).default("all"),
  lotKind: z.enum(["plan", "addon"]).optional(),
  storeId: IdSchema.optional(),
  occurredFrom: DateSchema.optional(),
  occurredTo: DateSchema.optional(),
});
export const AdminLedgerRowSchema = z.object({
  rowKey: z.string(),
  ledgerOperationId: IdSchema,
  opType: z.string(),
  category: z.enum(["grant", "purchase", "hold", "capture", "return", "expire", "adjust", "gate"]),
  lotKind: z.enum(["plan", "addon"]).nullable(),
  deltaPoints: z.int(),
  qty: count,
  occurredAt: InstantSchema,
  bizDate: DateSchema,
  title: z.string(),
  formula: z.string().nullable(),
  refNo: z.string().nullable(),
  store: store.nullable(),
  spendableAfterPoints: count,
  heldAfterPoints: count,
  actor: z.object({ type: z.string(), name: z.string() }),
});
export const AccountLedgerPageSchema = adminCursorPage(AdminLedgerRowSchema);
export type PointAccountFilter = z.infer<typeof PointAccountFilterSchema>;
export type PointAccountListQuery = z.infer<typeof PointAccountListQuerySchema>;
export type PointAdjustmentInput = z.infer<typeof PointAdjustmentInputSchema>;
export type AccountLedgerQuery = z.infer<typeof AccountLedgerQuerySchema>;
export type AdminLedgerRow = z.infer<typeof AdminLedgerRowSchema>;
export type PendingBillingCancel = z.infer<typeof PendingBillingCancelSchema>;

export const adminPointAccountList = adminRoute({
  request: { query: PointAccountListQuerySchema },
  responses: { ...okResponse(PointAccountPageSchema), ...errorResponses(400, 401, 403, 404) },
  method: "get",
  path: "/admin/point-accounts",
  operationId: "admin.pointAccount.list",
  summary:
    "积分账户列表（主体）：套餐、套餐积分与清零时间、加购积分、可用与冻结；筛选套餐与账户状态",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAccountSummary = adminRoute({
  request: { query: PointAccountFilterSchema },
  responses: { ...okResponse(PointAccountSummarySchema), ...errorResponses(400, 401, 403, 404) },
  method: "get",
  path: "/admin/point-accounts/summary",
  operationId: "admin.pointAccount.summary",
  summary: "积分账户页 KPI：积分余额（含冻结）、本月发放、本月消耗",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAccountGet = adminRoute({
  request: { params: PointAccountParamsSchema },
  responses: { ...okResponse(PointAccountDetailSchema), ...errorResponses(400, 401, 403, 404) },
  method: "get",
  path: "/admin/point-accounts/{pointAccountId}",
  operationId: "admin.pointAccount.get",
  summary: "积分账户详情：套餐、本期、可用 / 套餐 / 加购 / 冻结、在办退款与待审调整提示",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminPointAccountAdjustmentQuote = adminRoute({
  request: {
    params: PointAccountParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: PointAdjustmentInputSchema } },
    },
  },
  responses: { ...okResponse(PointAdjustmentQuoteSchema), ...errorResponses(400, 401, 403, 404) },
  method: "post",
  path: "/admin/point-accounts/{pointAccountId}/adjustment-quote",
  operationId: "admin.pointAccount.adjustmentQuote",
  summary: "积分调整影响预览：方向、类型、数量 → 可用 a → b",
  "x-permission": "billing.adjust.request",
  "x-idempotent": "none",
  "x-idempotent-reason": "试算（A20）",
});

export const adminPointAccountPointLedgerEntryList = adminRoute({
  request: { params: PointAccountParamsSchema, query: AccountLedgerQuerySchema },
  responses: { ...okResponse(AccountLedgerPageSchema), ...errorResponses(400, 401, 403, 404) },
  method: "get",
  path: "/admin/point-accounts/{pointAccountId}/point-ledger-entries",
  operationId: "admin.pointAccount.pointLedgerEntry.list",
  summary: "积分流水：分组（获得、使用、清零），时间倒序游标分页，每行带变动后可用余额",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
