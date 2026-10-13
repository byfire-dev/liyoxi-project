import {
  EntityQuotaUpdateBodySchema,
  EntityCloseBodySchema,
  ManagerAssignBodySchema,
  ManagerTransferBodySchema,
  MerchantUserStatusBodySchema,
  MerchantUserForceLogoutBodySchema,
  FollowUpUpdateBodySchema,
  FollowUpCompleteBodySchema,
  FollowUpCreateBodySchema,
  AssignmentContactBodySchema,
  AccountChangeCreateBodySchema,
  AccountChangeApproveBodySchema,
  AccountChangeRejectBodySchema,
  AccountChangeWithdrawBodySchema,
  ProxyEditBodySchema,
} from "@liyoxi/contract";
import { maxUploadBytes } from "@liyoxi/shared/uploads";
import { Alert, Button, Checkbox, Input, Modal, Select } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppServices } from "../../../app/services";
import { ConfirmAction, type ConfirmEchoItem } from "../../../components/ConfirmAction";
import { FormField } from "../../../components/FormField";
import { UploadField } from "../../../components/UploadField";
import type { UploadFn } from "../../../lib/upload";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
} from "../../../lib/upload-multipart";
import {
  type AccountRequest,
  type Entity,
  type Follow,
  type Member,
  type MerchantApi,
  type Profile,
  type StoreHeader,
  MerchantFailure,
} from "./api";
import { formError, text } from "./model";
export type Values = Readonly<Record<string, string>>;
export interface MerchantField {
  key: string;
  label: string;
  value?: string;
  options?: readonly { value: string; label: string }[];
  multiline?: boolean;
  max?: number;
  dateTime?: boolean;
}
export interface MerchantIntent {
  id: string;
  title: string;
  description?: string;
  echo: readonly ConfirmEchoItem[];
  danger?: boolean;
  fields: readonly MerchantField[];
  proofEntityId?: string;
  checks?: readonly string[];
  prepare(
    values: Values,
    proofs: readonly string[],
    checks: readonly string[],
  ): (api: MerchantApi, key: string) => Promise<unknown>;
}
const reason: MerchantField = { key: "reason", label: "原因（必填）", multiline: true, max: 500 };
const note: MerchantField = { key: "note", label: "备注（选填）", multiline: true, max: 200 };
export function quotaIntent(row: Entity): MerchantIntent {
  return {
    id: `quota:${row.entityId}:${row.lockVersion}`,
    title: "调整主体额度",
    echo: [
      { label: "主体", value: text(row.name) },
      { label: "原门店覆盖", value: String(row.usage.storeLimitOverride ?? "跟随套餐") },
      { label: "原成员覆盖", value: String(row.usage.memberLimitOverride ?? "跟随套餐") },
    ],
    fields: [
      {
        key: "stores",
        label: "门店上限覆盖（空白恢复套餐）",
        value: row.usage.storeLimitOverride?.toString() ?? "",
      },
      {
        key: "members",
        label: "成员上限覆盖（空白恢复套餐）",
        value: row.usage.memberLimitOverride?.toString() ?? "",
      },
      reason,
    ],
    prepare: (v) => {
      const body = EntityQuotaUpdateBodySchema.parse({
        storeLimitOverride: v.stores?.trim() ? Number(v.stores) : null,
        memberLimitOverride: v.members?.trim() ? Number(v.members) : null,
        lockVersion: row.lockVersion,
        confirm: {
          storeLimitOverride: row.usage.storeLimitOverride,
          memberLimitOverride: row.usage.memberLimitOverride,
        },
        reasonText: v.reason,
      });
      return (api, key) => api.quota(row.entityId, body, key);
    },
  };
}
export function closeIntent(row: Entity): MerchantIntent {
  return {
    id: `close:${row.entityId}`,
    title: "关闭经营主体",
    danger: true,
    description:
      "关闭会撤回邀请、移除成员、归档门店并撤销下载页会话；订阅、支付、退款、开票、订单与上线阻断以服务端复核为准。",
    echo: [
      { label: "主体", value: text(row.name) },
      { label: "在用门店", value: String(row.usage.storesUsed) },
      { label: "有效成员", value: String(row.usage.activeMemberCount) },
    ],
    fields: [{ ...reason, label: "关闭原因（10–200 字）", max: 200 }],
    prepare: (v) => {
      const body = EntityCloseBodySchema.parse({
        reasonText: v.reason,
        confirm: {
          activeStoreCount: row.usage.storesUsed,
          activeMemberCount: row.usage.activeMemberCount,
        },
      });
      return (api, key) => api.close(row.entityId, body, key);
    },
  };
}
export function userIntent(row: Member, kind: "disable" | "enable" | "logout"): MerchantIntent {
  const title = kind === "disable" ? "禁用账号" : kind === "enable" ? "启用账号" : "强制下线";
  return {
    id: `${kind}:${row.memberId}`,
    title,
    danger: kind !== "enable",
    echo: [
      { label: "账号", value: text(row.user.displayName) },
      { label: "手机号", value: text(row.user.phoneMask) },
    ],
    fields: [
      kind === "logout" ? { ...reason, label: "原因（选填）", max: 200 } : { ...reason, max: 200 },
    ],
    prepare: (v) => {
      const confirm = { phoneMask: row.user.phoneMask ?? "" };
      if (kind === "logout") {
        const body = MerchantUserForceLogoutBodySchema.parse({
          ...(v.reason?.trim() ? { reasonText: v.reason } : {}),
          confirm,
        });
        return (api, key) => api.logout(row.user.merchantUserId, body, key);
      }
      const body = MerchantUserStatusBodySchema.parse({ reasonText: v.reason, confirm });
      return (api, key) => api[kind](row.user.merchantUserId, body, key);
    },
  };
}
export function managerIntent(
  row: StoreHeader,
  options: readonly { value: string; label: string }[],
): MerchantIntent {
  const from = row.deliveryManager;
  return {
    id: `manager:${row.storeId}:${from?.staffId ?? "none"}`,
    title: from ? "转移交付经理" : "指派交付经理",
    description: "同步范围和后续联系时限以服务端实际结果为准。",
    echo: [
      { label: "门店", value: text(row.name) },
      { label: "原经理", value: text(from?.name) },
    ],
    fields: [
      { key: "staff", label: "新交付经理", options },
      ...(from
        ? [
            {
              key: "reasonCode",
              label: "转移原因",
              options: [
                { value: "workload", label: "工作量调整" },
                { value: "merchant_request", label: "商家要求" },
                { value: "staff_change", label: "人员调整" },
                { value: "other", label: "其他" },
              ],
            },
          ]
        : []),
      note,
    ],
    prepare: (v) => {
      if (from) {
        const body = ManagerTransferBodySchema.parse({
          toStaffId: v.staff,
          reasonCode: v.reasonCode,
          ...(v.note ? { note: v.note } : {}),
          confirm: { fromStaffId: from.staffId },
        });
        return (api, key) => api.transfer(row.storeId, body, key);
      }
      const body = ManagerAssignBodySchema.parse({
        toStaffId: v.staff,
        ...(v.note ? { note: v.note } : {}),
      });
      return (api, key) => api.assign(row.storeId, body, key);
    },
  };
}
export function contactedIntent(row: StoreHeader): MerchantIntent {
  return {
    id: `contact:${row.managerContact?.assignmentHistoryId}`,
    title: "标记已联系商家",
    echo: [
      { label: "门店", value: text(row.name) },
      { label: "交付经理", value: text(row.deliveryManager?.name) },
    ],
    fields: [note],
    prepare: (v) => {
      if (!row.managerContact) throw new Error("联系任务已变化，请刷新");
      const body = AssignmentContactBodySchema.parse(v.note ? { note: v.note } : {});
      return (api, key) => api.contacted(row.managerContact!.assignmentHistoryId, body, key);
    },
  };
}
export function followInput(value: string | null) {
  if (!value) return "";
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return "";
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 16);
}
export function followTime(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    const at = new Date(`${value}:00+08:00`);
    if (!Number.isFinite(at.getTime()) || followInput(at.toISOString()) !== value)
      throw new Error("请填写有效的北京时间");
    return at.toISOString();
  }
  // 正式ISO输入保持兼容；后面的原契约仍拒绝无时区和非法值。
  return value;
}
export function followIntent(
  row: Follow,
  kind: "update" | "complete" | "continue",
): MerchantIntent {
  return {
    id: `follow:${kind}:${row.followUpId}:${row.lockVersion}`,
    title: kind === "update" ? "调整跟进时间" : kind === "complete" ? "完成跟进" : "继续跟进",
    echo: [
      { label: "跟进对象", value: `${text(row.subjectType)} · ${row.subjectId}` },
      { label: "当前记录", value: text(row.content) },
    ],
    fields:
      kind === "complete"
        ? [note]
        : [
            {
              key: "next",
              label: "下次跟进时间（北京时间，空白清除）",
              dateTime: true,
              value: kind === "update" ? followInput(row.nextFollowAt) : "",
            },
            ...(kind === "continue"
              ? [
                  { key: "content", label: "跟进内容", multiline: true, max: 200 },
                  {
                    key: "channel",
                    label: "联系方式",
                    options: [
                      { value: "wecom", label: "企业微信" },
                      { value: "phone", label: "电话" },
                      { value: "visit", label: "拜访" },
                    ],
                  },
                ]
              : []),
          ],
    prepare: (v) => {
      if (kind === "complete") {
        const body = FollowUpCompleteBodySchema.parse({
          lockVersion: row.lockVersion,
          ...(v.note ? { doneNote: v.note } : {}),
        });
        return (api, key) => api.completeFollow(row.followUpId, body, key);
      }
      if (kind === "update") {
        const body = FollowUpUpdateBodySchema.parse({
          lockVersion: row.lockVersion,
          nextFollowAt: followTime(v.next),
        });
        return (api, key) => api.updateFollow(row.followUpId, body, key);
      }
      const body = FollowUpCreateBodySchema.parse({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        content: v.content,
        ...(v.channel ? { channel: v.channel } : {}),
        ...(v.next ? { nextFollowAt: followTime(v.next) } : {}),
      });
      return (api, key) => api.createFollow(body, key);
    },
  };
}
export function createAccountIntent(
  kind: "phone_rebind" | "owner_transfer" | "owner_reverify",
  row: Entity,
  target: Member["user"],
  reasons: readonly { value: string; label: string }[],
): MerchantIntent {
  return {
    id: `create:${kind}:${target.merchantUserId}`,
    title:
      kind === "phone_rebind"
        ? "申请手机号改绑"
        : kind === "owner_transfer"
          ? "申请更换老板"
          : "申请重认证放行",
    echo: [
      { label: "主体", value: text(row.name) },
      { label: "目标账号", value: text(target.displayName) },
      { label: "当前手机号", value: text(target.phoneMask) },
    ],
    fields: [
      { key: "reasonCode", label: "申请原因", options: reasons },
      { ...reason, label: "申请说明（必填）" },
      ...(kind === "owner_reverify"
        ? [
            { key: "method", label: "核验方式", max: 50 },
            { key: "record", label: "核验记录", multiline: true, max: 500 },
          ]
        : [
            {
              key: "phone",
              label: kind === "owner_transfer" ? "新老板手机号" : "新手机号",
              max: 11,
            },
          ]),
    ],
    proofEntityId: row.entityId,
    prepare: (v, proofs) => {
      const common = {
        kind,
        reasonCode: v.reasonCode,
        reasonText: v.reason,
        confirm: { targetPhoneMask: target.phoneMask ?? "" },
        proofFileIds: [...proofs],
      };
      const body = AccountChangeCreateBodySchema.parse(
        kind === "owner_transfer"
          ? { ...common, entityId: row.entityId, newPhone: v.phone }
          : kind === "phone_rebind"
            ? { ...common, merchantUserId: target.merchantUserId, newPhone: v.phone }
            : {
                ...common,
                merchantUserId: target.merchantUserId,
                verifyMethod: v.method,
                verifyRecord: v.record,
              },
      );
      return (api, key) => api.createRequest(body, key);
    },
  };
}
export function decideAccountIntent(
  row: AccountRequest,
  kind: "approve" | "reject" | "withdraw",
): MerchantIntent {
  return {
    id: `${kind}:${row.accountChangeRequestId}:${row.approval.lockVersion}`,
    title:
      kind === "approve" ? "批准账号变更" : kind === "reject" ? "驳回账号变更" : "撤回账号变更",
    danger: kind !== "approve",
    echo: [
      { label: "申请单", value: row.requestNo },
      { label: "目标手机号", value: text(row.target?.phoneMask) },
      { label: "新手机号", value: text(row.newPhoneMask) },
    ],
    fields:
      kind === "approve"
        ? []
        : [kind === "reject" ? { ...reason, label: "驳回说明（必填）", max: 200 } : note],
    checks: kind === "approve" ? row.confirmChecks : undefined,
    prepare: (v, _proofs, checks) => {
      if (kind === "approve") {
        const body = AccountChangeApproveBodySchema.parse({
          lockVersion: row.approval.lockVersion,
          confirm: { requestNo: row.requestNo, newPhoneMask: row.newPhoneMask },
          confirmChecks: [...checks],
        });
        return (api, key) => api.approveRequest(row.accountChangeRequestId, body, key);
      }
      if (kind === "reject") {
        const body = AccountChangeRejectBodySchema.parse({
          note: v.reason,
          confirm: { requestNo: row.requestNo },
        });
        return (api, key) => api.rejectRequest(row.accountChangeRequestId, body, key);
      }
      const body = AccountChangeWithdrawBodySchema.parse({
        ...(v.note ? { note: v.note } : {}),
        confirm: { requestNo: row.requestNo },
      });
      return (api, key) => api.withdrawRequest(row.accountChangeRequestId, body, key);
    },
  };
}
const profileFields = [
  ["brandName", "品牌名"],
  ["storeTel", "门店电话"],
  ["brandIntro", "品牌介绍"],
  ["promoText", "优惠说明"],
  ["groupBuyText", "团购说明"],
  ["sellingNote", "卖点补充"],
] as const;
export function profileIntent(row: Profile): MerchantIntent {
  return {
    id: `profile:${row.storeId}:${row.lockVersion}`,
    title: "代改免审档案",
    description: "仅修改当前允许的免审字段；门店名、行业、地址、联系人及资质仍由原审核流程处理。",
    echo: [
      { label: "门店", value: text(row.storeName) },
      { label: "档案版本", value: String(row.lockVersion) },
    ],
    fields: [
      ...profileFields
        .filter(([key]) => row.proxyEditableFields.includes(key))
        .map(([key, label]) => ({
          key,
          label,
          value: row[key] ?? "",
          multiline: key !== "brandName" && key !== "storeTel",
          max: 500,
        })),
      ...(row.proxyEditableFields.includes("avgSpendFen")
        ? [
            {
              key: "avgSpendFen",
              label: "人均消费（分，空白清除）",
              value: row.avgSpendFen?.toString() ?? "",
            },
          ]
        : []),
      {
        key: "reasonCode",
        label: "修改原因",
        options: [
          { value: "merchant_phone_request", label: "商家电话要求" },
          { value: "merchant_wecom_request", label: "商家企业微信要求" },
          { value: "data_correction", label: "数据纠正" },
          { value: "other", label: "其他" },
        ],
      },
      { ...note, max: 60 },
    ],
    prepare: (v) => {
      const patch: Record<string, unknown> = {
        lockVersion: row.lockVersion,
        reasonCode: v.reasonCode,
        ...(v.note ? { note: v.note } : {}),
      };
      for (const [key] of profileFields)
        if (row.proxyEditableFields.includes(key)) patch[key] = v[key]?.trim() || null;
      if (row.proxyEditableFields.includes("avgSpendFen"))
        patch.avgSpendFen = v.avgSpendFen?.trim() ? Number(v.avgSpendFen) : null;
      const body = ProxyEditBodySchema.parse(patch);
      return (api, key) => api.editProfile(row.storeId, body, key);
    },
  };
}
function ProofSlot({
  services,
  entityId,
  onChange,
}: {
  services: AppServices;
  entityId: string;
  onChange(id: string | null): void;
}) {
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | undefined>(undefined);
  useEffect(
    () => () => {
      adapter.current?.close();
      adapter.current = undefined;
    },
    [services, entityId],
  );
  const upload = useCallback<UploadFn>(
    (file, hooks) => {
      adapter.current ??= createMultipartUploadAdapter({
        ports: createAdminMultipartUploadPorts(services.api.client, {
          category: "account_proof",
          entityId,
        }),
      });
      return adapter.current.upload(file, hooks);
    },
    [services, entityId],
  );
  const rule = useMemo(
    () => ({
      accept: ["image/jpeg", "image/png", "application/pdf"],
      maxSizeMb: Number(maxUploadBytes("account_proof", "pdf", "admin")) / 1024 / 1024,
    }),
    [],
  );
  return <UploadField rule={rule} upload={upload} onChange={onChange} text="上传账号变更证明" />;
}
export function MerchantActionDialog({
  intent,
  api,
  services,
  refresh,
  close,
  done,
}: {
  intent: MerchantIntent;
  api: MerchantApi;
  services: AppServices;
  refresh(): Promise<unknown>;
  close(): void;
  done(message: string): void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
      Object.fromEntries(intent.fields.map((f) => [f.key, f.value ?? ""])),
    ),
    [proofs, setProofs] = useState<(string | null)[]>([null]),
    [checks, setChecks] = useState<string[]>([]),
    [error, setError] = useState<string>(),
    [send, setSend] = useState<ReturnType<MerchantIntent["prepare"]>>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return send ? (
    <ConfirmAction
      open
      action={intent.id}
      spec={{
        title: intent.title,
        description: intent.description,
        echo: intent.echo,
        checkLabel: "我已核对当前对象、信息和操作",
        danger: intent.danger,
      }}
      onCancel={close}
      onConfirm={async ({ idempotencyKey }) => {
        try {
          await send(api, idempotencyKey);
          await refresh();
          return { outcome: "done" };
        } catch (failure) {
          if (
            failure instanceof MerchantFailure &&
            failure.status === 409 &&
            failure.code !== "IDEMPOTENCY_IN_PROGRESS"
          ) {
            await refresh();
            if (alive.current) {
              close();
              done(`当前事实已变化（${failure.code}），请重新核对`);
            }
          }
          return { outcome: "failed", message: formError(failure) };
        }
      }}
      onDone={() => {
        if (alive.current) {
          close();
          done("操作成功，已刷新服务端实际状态");
        }
      }}
    />
  ) : (
    <Modal open title={intent.title} onCancel={close} footer={null} destroyOnHidden>
      <p>{intent.description}</p>
      {intent.fields.map((field) => (
        <FormField key={field.key} label={field.label}>
          {(props) =>
            field.options ? (
              <Select
                {...props}
                style={{ width: "100%" }}
                showSearch
                optionFilterProp="label"
                value={values[field.key] || undefined}
                options={[...field.options]}
                onChange={(value: string) => setValues({ ...values, [field.key]: value })}
              />
            ) : field.multiline ? (
              <Input.TextArea
                {...props}
                rows={3}
                maxLength={field.max}
                value={values[field.key]}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            ) : (
              <Input
                {...props}
                type={field.dateTime ? "datetime-local" : "text"}
                maxLength={field.max}
                value={values[field.key]}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            )
          }
        </FormField>
      ))}
      {intent.proofEntityId ? (
        <div aria-label="申请证明">
          <p>
            手机号改绑与更换老板至少 1 份证明，最多 9 份；重认证可不上传。上传成功后才计入申请。
          </p>
          {proofs.map((_proof, index) => (
            <ProofSlot
              key={index}
              services={services}
              entityId={intent.proofEntityId!}
              onChange={(id) =>
                setProofs((current) => current.map((old, i) => (i === index ? id : old)))
              }
            />
          ))}
          {proofs.length < 9 ? (
            <Button onClick={() => setProofs([...proofs, null])}>添加证明</Button>
          ) : null}
        </div>
      ) : null}
      {intent.checks?.map((check) => (
        <Checkbox
          key={check}
          checked={checks.includes(check)}
          onChange={(e) =>
            setChecks(e.target.checked ? [...checks, check] : checks.filter((v) => v !== check))
          }
        >
          {text(check)}
        </Checkbox>
      ))}
      {error ? <Alert type="error" title={error} /> : null}
      <div className="lyx-confirm__footer">
        <Button onClick={close}>取消</Button>
        <Button
          type="primary"
          onClick={() => {
            try {
              if (intent.checks?.some((check) => !checks.includes(check)))
                throw new Error("请逐项核对申请要求");
              const prepared = intent.prepare(
                values,
                proofs.filter((id): id is string => id !== null),
                checks,
              );
              setSend(() => prepared);
            } catch (failure) {
              setError(formError(failure));
            }
          }}
        >
          继续确认
        </Button>
      </div>
    </Modal>
  );
}
