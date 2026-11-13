import { ApiError } from "@/lib/request";
import type { PrivacyResult } from "@/lib/privacy";
import type { createPortalApprovalApi, PortalDecision, PortalPreview } from "./api";
import { assertPortalDecision, portalCode, ticketExpired } from "./model";

export type ApprovalState = {
  code: string;
  preview: PortalPreview | null;
  decision: PortalDecision | null;
  notice: string | null;
};
type Scope = { store: string | null; token: string | null; role?: string };
type Current = () => boolean;
type Intent = (action: string, value: unknown) => string;
type Deps = {
  api: ReturnType<typeof createPortalApprovalApi>;
  scope: () => Scope;
  identity: () => string;
  now: () => number;
  withPrivacy: <T>(call: () => Promise<T>) => Promise<PrivacyResult<T>>;
  scan: () => Promise<{ result: string }>;
};
const empty = (): ApprovalState => ({ code: "", preview: null, decision: null, notice: null });
const invalidMessages: Record<string, string> = {
  not_found: "未找到此登录码，请核对代码或在电脑上刷新后重新输入。",
  expired: "登录码已过期，请在电脑上刷新后重新输入。",
  rejected: "此登录码已作废，请在电脑上刷新后重新输入。",
  consumed: "此登录码已使用，请在电脑上刷新后重新输入。",
  approved: "此登录已确认，请回到电脑继续；如需重新授权，请在电脑上刷新登录码。",
};
export function approvalProblem(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.error === "ROLE_FORBIDDEN") return "仅老板可授权电脑，请切换到老板门店。";
  if (["NOT_A_MEMBER", "CAPABILITY_DENIED", "FORBIDDEN", "NOT_FOUND"].includes(error.error))
    return "当前门店权限已变化，请重新选择门店后核对授权。";
  if (error.error !== "PORTAL_TICKET_INVALID") return null;
  const details = error.details;
  const reason =
    details && typeof details === "object" && "reason" in details ? details.reason : null;
  return typeof reason === "string" && Object.hasOwn(invalidMessages, reason)
    ? invalidMessages[reason]!
    : "此登录码已失效，请在电脑上刷新后重新输入。";
}

/** 仅管理本页确认内容；同步锁、身份代次、请求与幂等键仍由 delivery resource 提供。 */
export function createPortalApprovalFlow(deps: Deps, initial = "") {
  const identity = deps.identity();
  let state = empty();
  let revision = 0;
  let initialPending = Boolean(initial);
  let native: object | null = null;
  const capture = (current: Current) => {
    const mine = revision;
    return () => mine === revision && identity === deps.identity() && current();
  };
  const commit = (next: ApprovalState, current: Current) => {
    if (!current()) return null;
    state = next;
    return state;
  };
  const problem = (error: unknown, current: Current) => {
    if (!current()) return null;
    const notice = approvalProblem(error);
    if (!notice) throw error;
    return commit({ ...empty(), notice }, current);
  };
  const access = () => {
    const scope = deps.scope();
    if (!scope.token) throw new Error("请先登录，再核对电脑授权");
    if (scope.role !== "owner") throw new Error("仅老板可授权电脑，请切换到老板门店");
  };
  async function find(input: string, parent: Current): Promise<ApprovalState | null> {
    const current = capture(parent);
    if (!current()) return null;
    access();
    const code = portalCode(input);
    if (!code) throw new Error("请输入电脑显示的8位登录代码，或扫描电脑上的登录二维码");
    try {
      const preview = await deps.api.lookup(code);
      if (!current()) return null;
      if (preview.storeId !== deps.scope().store)
        throw new Error("当前门店已变化，请重新核对电脑授权");
      if (ticketExpired(preview.expiresAt, deps.now()))
        return commit({ ...empty(), notice: invalidMessages.expired! }, current);
      return commit({ code, preview, decision: null, notice: null }, current);
    } catch (error) {
      return problem(error, current);
    }
  }
  return {
    snapshot: () => (identity === deps.identity() ? state : empty()),
    nativePending: () => native !== null,
    reset: () => {
      revision += 1;
      initialPending = false;
      native = null;
      state = empty();
      return state;
    },
    load: async (parent: Current) => {
      const current = capture(parent);
      if (!current()) return null;
      if (initialPending) {
        initialPending = false;
        return find(initial, current);
      }
      // 显式刷新核对中的票据；取消或终态以后不重新打开旧 route 的初始代码。
      return state.preview ? find(state.code, current) : current() ? state : null;
    },
    find,
    scan: async (parent: Current) => {
      const current = capture(parent);
      if (!current()) return null;
      access();
      let result: PrivacyResult<{ result: string } | null>;
      const owner = {};
      native = owner;
      try {
        result = await deps.withPrivacy(() => (current() ? deps.scan() : Promise.resolve(null)));
      } catch (error) {
        if (!current()) return null;
        const canceled =
          error &&
          typeof error === "object" &&
          "errMsg" in error &&
          typeof error.errMsg === "string" &&
          /cancel/i.test(error.errMsg);
        return commit(
          {
            ...empty(),
            notice: canceled
              ? "已取消扫码，可手输登录代码或再次扫码。"
              : "扫码未完成，请重试或手输登录代码。",
          },
          current,
        );
      } finally {
        if (native === owner) native = null;
      }
      if (!current() || (result.ok && !result.value)) return null;
      if (!result.ok)
        return commit(
          { ...empty(), notice: "你尚未同意隐私指引，可手输登录代码，也可再次点击扫码。" },
          current,
        );
      const code = portalCode(result.value!.result);
      if (!code)
        return commit(
          { ...empty(), notice: "这不是电脑登录码，请扫描电脑登录页的二维码。" },
          current,
        );
      return find(code, current);
    },
    decide: async (approve: boolean, pair: string, parent: Current, intent: Intent) => {
      const current = capture(parent);
      if (!current() || !state.preview) return null;
      access();
      const preview = state.preview;
      if (ticketExpired(preview.expiresAt, deps.now()))
        return commit({ ...empty(), notice: invalidMessages.expired! }, current);
      assertPortalDecision(preview, deps.scope(), deps.now(), approve ? pair : undefined);
      const key = intent(approve ? "portal-approve" : "portal-reject", {
        id: preview.portalTicketId,
        revision,
        ...(approve ? { pair } : {}),
      });
      try {
        const decision = approve
          ? await deps.api.approve(preview.portalTicketId, pair, key)
          : await deps.api.reject(preview.portalTicketId, key);
        if (!current()) return null;
        if (
          decision.portalTicketId !== preview.portalTicketId ||
          (decision.status === "approved" && decision.storeId !== preview.storeId)
        )
          throw new Error("授权结果与本次核对不一致，请重新查看电脑上的登录状态");
        return commit({ code: "", preview: null, decision, notice: null }, current);
      } catch (error) {
        return problem(error, current);
      }
    },
  };
}
