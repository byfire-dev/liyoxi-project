import type { components } from "@liyoxi/contract/types/admin";

import { readFailure, type ApiFailure } from "../../lib/api-errors";
import { newIdempotencyKey } from "../../lib/idempotency";
import type { AccessSnapshot } from "../../lib/permissions";
import type { StaffRow } from "./staff-model";

export type StaffDetail = components["schemas"]["StaffDetail"];
export type OpenWork = components["schemas"]["OpenWorkSummary"];
export type Activation = components["schemas"]["ActivationIssue"];
export type StaffSession = components["schemas"]["StaffSessionView"];
export class AccessFailure extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}
export async function accessResult<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  const response =
    result.error === undefined
      ? result.response
      : new Response(JSON.stringify(result.error), {
          status: result.response.status,
          headers: result.response.headers,
        });
  throw new AccessFailure(await readFailure(response));
}
export async function accessEmpty(result: {
  data?: { code: 0; message: "ok" };
  error?: unknown;
  response: Response;
}): Promise<void> {
  if (result.data?.code === 0) return;
  await accessResult({ error: result.error, response: result.response });
}
export function actorScope(access: AccessSnapshot | null): string {
  return access
    ? JSON.stringify([
        access.staff.id,
        access.staff.roleKey,
        access.isLead,
        access.dataScope,
        access.moduleLevels,
        access.actions,
      ])
    : "anonymous";
}
const actionPermissions: Readonly<Record<string, string>> = {
  update: "sys.staff.manage",
  enable: "sys.staff.manage",
  disable: "sys.staff.secure_ops",
  handover: "sys.staff.manage",
  "reset-password": "sys.staff.secure_ops",
  "reset-mfa": "sys.staff.secure_ops",
  "reissue-activation-code": "sys.staff.manage",
  unlock: "sys.staff.manage",
  "invite-wecom": "sys.staff.wecom_bind",
  "bind-wecom": "sys.staff.wecom_bind",
};
export const staffActionLabels: Readonly<Record<string, string>> = {
  update: "编辑员工",
  enable: "启用员工",
  disable: "禁用员工",
  handover: "移交在办",
  "reset-password": "重置密码",
  "reset-mfa": "重置动态口令",
  "reissue-activation-code": "补发激活码",
  unlock: "解除锁定",
  "invite-wecom": "邀请绑定企业微信",
  "bind-wecom": "录入企业微信账号",
};
export function allowedStaffActions(row: Pick<StaffRow, "actions">, access: AccessSnapshot | null) {
  return row.actions.filter(
    (action) =>
      typeof action === "string" &&
      actionPermissions[action] &&
      access?.actions.includes(actionPermissions[action]),
  );
}
/** 与现有创建意图同一约定：同步防双击，失败重试保键，实质内容改动换键。 */
export function writeIntent(action: string, keyFactory = () => newIdempotencyKey(action)) {
  let body = "",
    key = "",
    pending = false,
    completed = false;
  return {
    async run<T>(value: unknown, send: (key: string) => Promise<T>): Promise<T | undefined> {
      if (pending || completed) return undefined;
      const fingerprint = JSON.stringify(value);
      if (fingerprint !== body || !key) {
        body = fingerprint;
        key = keyFactory();
      }
      pending = true;
      try {
        const result = await send(key);
        completed = true;
        return result;
      } finally {
        pending = false;
      }
    },
  };
}
export function activationMessage(value: Activation): string {
  if (value.replayed) return "本次是重放结果，激活码不再展示；需要新码请重新补发。";
  return value.activationCode
    ? "激活码只展示这一次，请线下转交；不代表短信已送达。"
    : "本次没有返回激活码，请按实际发送状态联系员工；不代表短信已送达。";
}
export function workReady(
  work: OpenWork | undefined,
  target: string,
  reason: string,
  note: string,
) {
  return Boolean(
    work &&
    (work.total === 0 || work.candidates.some((row) => row.staffId === target)) &&
    (reason !== "other" || note.trim()),
  );
}
