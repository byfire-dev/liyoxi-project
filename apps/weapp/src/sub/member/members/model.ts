import { ApiError } from "@/lib/request";
import type { Me } from "./api";

export const currentMembership = (me: Me | null, storeId: string | null) =>
  me?.memberships.find((m) => m.stores.some((s) => s.storeId === storeId)) ?? null;

export function tenantError(failure: unknown): string {
  if (!(failure instanceof ApiError))
    return failure instanceof Error ? failure.message : "操作失败，请重试";
  const details = failure.details;
  const names: Readonly<Record<string, string>> = {
    open_order: "在办订购",
    open_delivery_ticket: "在办交付",
    ad_in_production: "制作中广告",
    qualification_in_review: "审核中资质",
    channel_account_in_review: "审核中发布账号",
    unverified_primary_store: "未认证的首家门店",
  };
  const blockers =
    details &&
    typeof details === "object" &&
    "blockers" in details &&
    Array.isArray(details.blockers)
      ? details.blockers.flatMap((b: unknown) =>
          b && typeof b === "object" && "kind" in b && "count" in b
            ? [`${names[String(b.kind)] ?? "需处理事项"} ${String(b.count)} 项`]
            : [],
        )
      : [];
  const fields = failure.fieldErrors?.map((f) => f.message) ?? [];
  return [failure.message, ...fields, ...blockers].join("；");
}

/** 本域一次写意图：上下文更换可开启新操作，旧finally只释放自己的所有权。 */
export function createTenantAction(context: () => string, key: () => string) {
  let live = true,
    visible = true;
  let owner: object | null = null;
  let intent: { fingerprint: string; key: string } | null = null;
  let state: { busy: boolean; error: string | null } = { busy: false, error: null };
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => {
    state = next;
    for (const f of listeners) f();
  };
  const invalidate = () => {
    owner = null;
    publish({ busy: false, error: null });
  };
  return {
    snapshot: () => state,
    subscribe(f: () => void) {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    invalidate,
    activate() {
      live = true;
      visible = true;
    },
    hide() {
      visible = false;
      invalidate();
    },
    dispose() {
      live = false;
      invalidate();
    },
    async run<T>(
      body: unknown,
      call: (key: string, current: () => boolean) => Promise<T>,
    ): Promise<T | undefined> {
      if (!live || !visible || owner) return undefined;
      const at = context(),
        owned = {};
      const fingerprint = JSON.stringify({ at, body });
      if (!intent || intent.fingerprint !== fingerprint) intent = { fingerprint, key: key() };
      const requestKey = intent.key;
      owner = owned;
      const current = () => live && visible && owner === owned && at === context();
      publish({ busy: true, error: null });
      try {
        const result = await call(requestKey, current);
        if (!current()) return undefined;
        intent = null;
        return result;
      } catch (e) {
        if (current()) publish({ busy: true, error: tenantError(e) });
        return undefined;
      } finally {
        if (owner === owned) {
          owner = null;
          if (live) publish({ ...state, busy: false });
        }
      }
    },
  };
}
