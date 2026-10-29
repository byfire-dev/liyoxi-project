import {
  adminPage,
  FinanceConfigViewSchema,
  FinanceConfigCreateBodySchema,
  FinanceConfigApproveBodySchema,
  FinanceConfigRejectBodySchema,
  FinanceConfigWithdrawBodySchema,
} from "@liyoxi/contract";
import type { FinanceConfigCreateBody } from "@liyoxi/contract";
import type { operations } from "@liyoxi/contract/types/admin";
import type { AppServices } from "../../../app/services";
import { readFailure, requestIdTail } from "../../../lib/api-errors";
import type { ConfigDecision, ConfigRevision } from "./types";

export class ConfigFailure extends Error {
  constructor(
    readonly symbol: string,
    readonly status = 0,
    readonly tail: string | null = null,
  ) {
    super(symbol);
  }
}
export function configError(error: unknown) {
  const labels: Readonly<Record<string, string>> = {
    PERMISSION_DENIED: "当前权限无法处理财务配置",
    NOT_FOUND: "配置版本不存在或已不可见",
    VERSION_CONFLICT: "版本已变化，请重新核对",
    CONFIRM_MISMATCH: "配置基准或确认内容已变化，请重新核对",
    PRECONDITION_CHANGED: "处理条件已变化，请重新核对",
    STATE_NOT_ALLOWED: "当前版本已被处理，请重新核对",
    APPROVAL_SELF_FORBIDDEN: "提议人不能审批自己的变更",
    CHANGESET_EMPTY: "配置没有变化，请修改后提交",
    APPROVAL_ALREADY_PENDING: "该配置已有待审批提议，请先处理",
    VALIDATION_FAILED: "请检查配置内容与变更说明",
    STEP_UP_REQUIRED: "请完成再次验证后重试",
    IDEMPOTENCY_IN_PROGRESS: "同一操作仍在处理中，请稍后重试",
    RESPONSE_MISMATCH: "配置响应关联不一致，已停止处理",
    REFRESH_FAILED: "操作已提交成功，详情读取失败，请重新读取，不要重复提交",
  };
  return `${labels[error instanceof ConfigFailure ? error.symbol : "UNKNOWN"] ?? "请求未确认成功，请重试；同一内容保留原操作编号"}${error instanceof ConfigFailure && error.tail ? `（请求编号 ${error.tail}）` : ""}`;
}
export const configConflict = (error: unknown) =>
  error instanceof ConfigFailure && error.status === 409;
async function result<T>(res: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (res.data) return res.data.data;
  const source =
    res.error === undefined
      ? res.response
      : new Response(JSON.stringify(res.error), {
          status: res.response.status,
          headers: res.response.headers,
        });
  const failure = await readFailure(source);
  throw new ConfigFailure(failure.symbol, failure.status, requestIdTail(failure.requestId));
}
function verify(
  row: ConfigRevision,
  id?: string,
  key?: ConfigRevision["configKey"],
  approvalId?: string,
) {
  if (
    row.approval.kind !== "finance_config_change" ||
    (id && row.financeConfigRevisionId !== id) ||
    (key && row.configKey !== key) ||
    (approvalId && row.approval.approvalId !== approvalId)
  )
    throw new ConfigFailure("RESPONSE_MISMATCH");
  return row;
}
const pageSchema = adminPage(FinanceConfigViewSchema);
type ListQuery = NonNullable<operations["admin.financeConfigRevision.list"]["parameters"]["query"]>;
export function createConfigApi(services: Pick<AppServices, "api">) {
  const client = services.api.client;
  const list = async (query: ListQuery, signal: AbortSignal) => {
    const data = await result(
      await client.GET("/api/v1/admin/finance-config-revisions", { params: { query }, signal }),
    );
    // 契约current/history是联合；按请求分支解析，避免items分支剥掉history分页信息。
    const page =
      query.tab === "history"
        ? pageSchema.parse(data)
        : {
            items: data.items.map((item) => FinanceConfigViewSchema.parse(item)),
            page: 1,
            pageSize: data.items.length || 20,
            total: data.items.length,
          };
    page.items.forEach((row) => verify(row, query.financeConfigRevisionId, query.configKey));
    return page;
  };
  return {
    list,
    async get(id: string, signal: AbortSignal) {
      const page = await list(
        { tab: "history", financeConfigRevisionId: id, page: 1, pageSize: 20 },
        signal,
      );
      if (page.items.length !== 1 || page.total !== 1) throw new ConfigFailure("NOT_FOUND");
      return verify(page.items[0]!, id);
    },
    async create(body: FinanceConfigCreateBody, key: string, signal: AbortSignal) {
      return verify(
        FinanceConfigViewSchema.parse(
          await result(
            await client.POST("/api/v1/admin/finance-config-revisions", {
              body: FinanceConfigCreateBodySchema.parse(body),
              headers: { "Idempotency-Key": key },
              signal,
            }),
          ),
        ),
        undefined,
        body.configKey,
      );
    },
    async decide(
      value: ConfigRevision,
      action: ConfigDecision,
      note: string,
      last4: string,
      key: string,
      signal: AbortSignal,
    ) {
      const params = { path: { financeConfigRevisionId: value.financeConfigRevisionId } },
        shared = { params, signal, headers: { "Idempotency-Key": key } };
      const res =
        action === "approve"
          ? await client.POST(
              "/api/v1/admin/finance-config-revisions/{financeConfigRevisionId}/approve",
              {
                ...shared,
                body: FinanceConfigApproveBodySchema.parse({
                  lockVersion: value.approval.lockVersion,
                  confirmChecks: ["change_reviewed"],
                  confirm: {
                    configKey: value.configKey,
                    financeConfigRevisionId: value.financeConfigRevisionId,
                    ...(value.configKey === "bank_account" ? { accountNoLast4: last4 } : {}),
                  },
                  note: note || undefined,
                }),
              },
            )
          : action === "reject"
            ? await client.POST(
                "/api/v1/admin/finance-config-revisions/{financeConfigRevisionId}/reject",
                { ...shared, body: FinanceConfigRejectBodySchema.parse({ note }) },
              )
            : await client.POST(
                "/api/v1/admin/finance-config-revisions/{financeConfigRevisionId}/withdraw",
                {
                  ...shared,
                  body: FinanceConfigWithdrawBodySchema.parse({ note: note || undefined }),
                },
              );
      return verify(
        FinanceConfigViewSchema.parse(await result(res)),
        value.financeConfigRevisionId,
        value.configKey,
        value.approval.approvalId,
      );
    },
  };
}
export type ConfigApi = ReturnType<typeof createConfigApi>;
