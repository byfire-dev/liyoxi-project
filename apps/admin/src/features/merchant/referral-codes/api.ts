import {
  ReferralCodeListSchema,
  ReferralCodeRowSchema,
  StaffBriefSchema,
  z,
} from "@liyoxi/contract";
import type { operations, components } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { accessResult } from "../../system/staff-access";

// 只放开正式 open-enum 读字段；其余结构仍取契约并严格校验。
const StaffRead = StaffBriefSchema.extend({ roleKey: z.string(), status: z.string() });
const RowRead = ReferralCodeRowSchema.extend({
  sourceType: z.string(),
  status: z.string(),
  owner: StaffRead.nullable(),
});
const PageRead = ReferralCodeListSchema.extend({ items: z.array(RowRead) });
export type ReferralRow = z.output<typeof RowRead>;
export type ReferralQuery = NonNullable<
  operations["admin.referralCode.list"]["parameters"]["query"]
>;
export type ReferralBody = components["schemas"]["ReferralCodeCreateBody"];
function read<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("渠道码响应不符合契约，请刷新重试");
  return parsed.data;
}
export function createReferralApi({ api }: Pick<AppServices, "api">) {
  const c = api.client;
  return {
    list: (query: ReferralQuery, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/referral-codes", { params: { query }, signal })
        .then(accessResult)
        .then((value) => read(PageRead, value)),
    create: (body: ReferralBody, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/referral-codes", { body, headers: { "Idempotency-Key": key }, signal })
        .then(accessResult)
        .then((value) => read(RowRead, value)),
    disable: (id: string, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/referral-codes/{referralCodeId}/disable", {
          params: { path: { referralCodeId: id } },
          body: {},
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(accessResult)
        .then((value) => read(RowRead, value)),
    enable: (id: string, key: string, signal?: AbortSignal) =>
      c
        .POST("/api/v1/admin/referral-codes/{referralCodeId}/enable", {
          params: { path: { referralCodeId: id } },
          body: {},
          headers: { "Idempotency-Key": key },
          signal,
        })
        .then(accessResult)
        .then((value) => read(RowRead, value)),
    owners: (q: string, page: number, signal?: AbortSignal) =>
      c
        .GET("/api/v1/admin/staff", {
          params: {
            query: {
              page,
              pageSize: 20,
              status: "active",
              ...(q.trim() ? { q: q.trim().slice(0, 20) } : {}),
            },
          },
          signal,
        })
        .then(accessResult)
        .then((value) => ({
          // 选人只读取正式 StaffBrief 子集，不复制员工管理 DTO。
          items: value.items.map((item) => read(StaffRead, item)),
          total: value.total,
        })),
  };
}
export type ReferralApi = ReturnType<typeof createReferralApi>;
