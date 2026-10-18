import type { components } from "@liyoxi/contract/types/admin";
import { StaffListQuerySchema } from "@liyoxi/contract/queries/admin";
import { STAFF_ROLE_KEY } from "@liyoxi/contract/enums";

import { newIdempotencyKey } from "../../lib/idempotency";
import { readTableSearch, toListQuery, type TableSearch } from "../../lib/table-search";
import { readContractQuery } from "../../lib/contract-query";

export type StaffRow = components["schemas"]["StaffListItem"];
export type Role = components["schemas"]["RoleSummary"];
export type StaffBody = components["schemas"]["StaffCreateBody"];
export type StaffResult = components["schemas"]["StaffMutationResult"];
export const STAFF_LIST_KEY = ["system", "staff", "list"] as const;
export const STAFF_ROLES_KEY = ["system", "staff", "roles"] as const;

export function staffSearch(raw: Readonly<Record<string, unknown>>): TableSearch {
  const search = readTableSearch(raw, ["roleKey", "status"]);
  const { wire } = readContractQuery(StaffListQuerySchema, toListQuery(search), {
    keys: ["q", "page", "pageSize", "roleKey", "status", "sort"],
    defaults: { page: "1", pageSize: "20" },
    keywordLimit: 20,
  });
  return readTableSearch(wire, ["roleKey", "status"]);
}
export function staffLabel(row: Pick<StaffRow, "status" | "isActivated">): string {
  if (row.status === "active") return row.isActivated ? "启用" : "待激活";
  return row.status === "pending" ? "待启用" : row.status === "disabled" ? "已禁用" : "未知状态";
}
export function scopeLabel(scope: string): string {
  return (
    ({ own: "本人负责", group: "本组全部", all: "全部" } as Record<string, string>)[scope] ?? "—"
  );
}
export function canActivateRole(role: Role | undefined, partner: boolean): boolean {
  return role?.availableFrom === "v1.0" || (role?.availableFrom === "v1.1" && partner);
}
export interface StaffDraft {
  name: string;
  phone: string;
  roleKey: string;
  isLead: boolean;
  activateNow: boolean;
}
export function staffBody(
  draft: StaffDraft,
  roles: readonly Role[],
  partner: boolean,
): {
  body?: StaffBody;
  errors: Partial<Record<"name" | "phone" | "roleKey", string>>;
} {
  const errors: Partial<Record<"name" | "phone" | "roleKey", string>> = {};
  const name = draft.name.trim();
  if (!name || name.length > 10) errors.name = "请填写 1–10 字的姓名";
  if (!/^1\d{10}$/.test(draft.phone)) errors.phone = "请填写 11 位手机号";
  const role = roles.find((item) => item.roleKey === draft.roleKey);
  if (!role || !(STAFF_ROLE_KEY.values as readonly string[]).includes(draft.roleKey))
    errors.roleKey = "请选择可用角色";
  else if (draft.activateNow && !canActivateRole(role, partner))
    errors.roleKey = "这个角色尚未开放，请选择暂不启用";
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    body: {
      name,
      phone: draft.phone,
      roleKey: draft.roleKey as StaffBody["roleKey"],
      isLead: draft.isLead,
      activateNow: draft.activateNow,
      activationDelivery: "manual",
      inviteWecom: false,
    },
  };
}

/** 一个弹层一份意图；重试复用，内容改动换键，同步锁挡住双击，成功后不再提交。 */
export function createStaffIntent(
  send: (body: StaffBody, key: string) => Promise<StaffResult>,
  newKey = () => newIdempotencyKey("staff-create"),
) {
  let key = newKey();
  let running = false;
  let completed = false;
  return {
    get pending() {
      return running || completed;
    },
    change() {
      if (!running && !completed) key = newKey();
    },
    async submit(body: StaffBody): Promise<StaffResult | null> {
      if (running || completed) return null;
      running = true;
      try {
        const result = await send(body, key);
        completed = true;
        return result;
      } finally {
        running = false;
      }
    },
  };
}
export type CreationView = { name: string; message: string; code?: string; expiresAt?: string };
export function creationView(
  result: Pick<StaffResult, "activation" | "replayed"> & {
    staff: Pick<StaffRow, "name" | "status">;
  },
): CreationView {
  const name = result.staff.name;
  const activation = result.activation;
  if (result.replayed || activation?.replayed)
    return { name, message: "账号已创建。本次是重试结果，激活码不再展示。" };
  if (activation?.delivery === "manual" && activation.activationCode)
    return {
      name,
      message: "激活码只展示这一次，请线下转交给员工。",
      code: activation.activationCode,
      expiresAt: activation.expiresAt,
    };
  return {
    name,
    message:
      result.staff.status === "pending"
        ? "账号已创建，暂不启用。可在员工详情中核对并启用。"
        : "账号已创建，本次没有返回激活码，请联系管理员。",
  };
}
