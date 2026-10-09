import "./staff-access.css";
import { ASSIGNMENT_POOL } from "@liyoxi/contract/enums";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Drawer, Input, Modal, Select, Table } from "antd";
import { useContext, useRef, useState } from "react";

import type { AppServices } from "../../app/services";
import { ConfirmAction, type ConfirmSpec } from "../../components/ConfirmAction";
import { FormField } from "../../components/FormField";
import { ReadOnlyValue } from "../../components/ReadOnlyValue";
import { ErrorState } from "../../components/StateBlock";
import { SimplePager } from "../../components/SimplePager";
import { AccessContext } from "../../lib/permissions";
import { DETAIL_QUERY } from "../../lib/query";
import {
  accessResult,
  AccessFailure,
  actorScope,
  activationMessage,
  allowedStaffActions,
  staffActionLabels,
  workReady,
  type Activation,
  type StaffDetail,
  type OpenWork,
  type StaffSession,
} from "./staff-access";
import { STAFF_LIST_KEY, type Role } from "./staff-model";
import { commandDraft, sendStaffCommand, type StaffCommandDraft } from "./staff-commands";

const poolLabels: Readonly<Record<string, string>> = {
  cs: "客服",
  delivery_manager: "交付经理",
  editor: "剪辑",
  publisher: "发布",
};
const wecomLabels: Readonly<Record<string, string>> = {
  none: "未绑定",
  invited: "已邀请",
  bound: "已绑定",
  unbound: "已解绑",
};
const workSourceLabels: Readonly<Record<string, string>> = {
  store_manager: "专属服务门店",
  ticket_editor: "剪辑工单",
  ticket_publisher: "发布工单",
  ad_editor: "广告制作",
  service_ticket_owner: "客服工单",
  follow_up_owner: "跟进记录",
};
export function StaffDrawer({
  staffId,
  services,
  roles,
  close,
}: {
  staffId: string;
  services: AppServices;
  roles: readonly Role[];
  close: () => void;
}) {
  const scope = actorScope(useContext(AccessContext));
  const detail = useQuery({
    queryKey: [...STAFF_LIST_KEY, scope, "detail", staffId],
    ...DETAIL_QUERY,
    queryFn: async () =>
      (await accessResult(
        await services.api.client.GET("/api/v1/admin/staff/{staffId}", {
          params: { path: { staffId } },
        }),
      )) as unknown as StaffDetail,
  });
  return (
    <Drawer open title="员工详情" width={560} onClose={close} destroyOnHidden>
      {detail.isPending ? (
        <p aria-busy="true">正在读取员工…</p>
      ) : detail.isError ? (
        <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
      ) : (
        <StaffDetailBody
          key={staffId}
          services={services}
          staff={detail.data}
          roles={roles}
          refresh={async () => {
            await Promise.all([
              detail.refetch(),
              services.queryClient.invalidateQueries({ queryKey: STAFF_LIST_KEY }),
            ]);
          }}
        />
      )}
    </Drawer>
  );
}
function StaffDetailBody({
  services,
  staff,
  roles,
  refresh,
}: {
  services: AppServices;
  staff: StaffDetail;
  roles: readonly Role[];
  refresh: () => Promise<void>;
}) {
  const access = useContext(AccessContext);
  const [action, setAction] = useState<string>(),
    [activation, setActivation] = useState<Activation>();
  const [sessions, setSessions] = useState(false),
    [notice, setNotice] = useState<string>();
  const actions = allowedStaffActions(staff, access);
  const dutyAllowed =
    staff.roleKey === "cs" &&
    (staff.isSelf ||
      (access?.staff.roleKey === "cs" &&
        access.isLead &&
        access.actions.includes("service.ticket.assign")));
  return (
    <>
      <ReadOnlyValue label="姓名 / 工号" value={`${staff.name} / ${staff.staffNo}`} />
      <ReadOnlyValue label="手机号（已脱敏）" value={staff.phoneMask ?? "—"} />
      <ReadOnlyValue
        label="角色 / 分组"
        value={`${roles.find((role) => role.roleKey === staff.roleKey)?.name ?? staff.roleKey} / ${staff.staffGroup?.name ?? "—"}`}
      />
      <ReadOnlyValue
        label="企业微信"
        value={staff.wecom.userid ?? wecomLabels[staff.wecom.status] ?? "未知状态"}
      />
      <ReadOnlyValue label="激活状态" value={staff.isActivated ? "已激活" : "未激活"} />
      <ReadOnlyValue label="动态口令" value={staff.security.totpEnrolledAt ? "已绑定" : "未绑定"} />
      <ReadOnlyValue label="恢复码剩余" value={String(staff.security.recoveryCodesLeft)} />
      <ReadOnlyValue
        label="最近登录"
        value={staff.lastLoginAt ? appDateTimeFormat.dateTime(staff.lastLoginAt) : "从未登录"}
      />
      <ReadOnlyValue
        label="当前分配池"
        value={
          staff.poolMemberships
            .map(
              (row) =>
                `${poolLabels[String(row.pool)] ?? row.pool}${row.city ? ` / ${row.city.name}` : ""}${row.onDuty ? " / 当班" : ""}`,
            )
            .join("；") || "未加入"
        }
      />
      {notice ? <Alert type="info" title={notice} role="status" /> : null}
      <div className="lyx-access-actions">
        {actions.map((key) => (
          <Button
            key={String(key)}
            danger={key === "disable"}
            onClick={() => setAction(String(key))}
          >
            {staffActionLabels[String(key)]}
          </Button>
        ))}
        {staff.status === "active" && access?.actions.includes("sys.staff.manage") ? (
          <Button onClick={() => setAction("pools")}>设置分配池</Button>
        ) : null}
        {dutyAllowed ? <DutyButton services={services} staff={staff} refresh={refresh} /> : null}
        {access?.actions.includes("sys.session.revoke") ? (
          <Button onClick={() => setSessions(true)}>在线会话</Button>
        ) : null}
      </div>
      {action ? (
        <StaffCommand
          key={`${staff.staffId}:${action}`}
          action={action}
          services={services}
          staff={staff}
          roles={roles}
          close={() => setAction(undefined)}
          refresh={refresh}
          conflict={() => {
            setAction(undefined);
            setNotice("内容已变化，已重新读取。请打开操作并核对最新版本及在办量。");
          }}
          done={(value) => {
            setAction(undefined);
            setNotice("员工信息已更新并重新读取。");
            if (value && typeof value === "object") {
              if ("activation" in value && value.activation)
                setActivation(value.activation as Activation);
              else if ("activationCode" in value) setActivation(value as Activation);
            }
          }}
        />
      ) : null}
      {activation ? (
        <Modal
          open
          title="一次性激活码"
          footer={null}
          destroyOnHidden
          onCancel={() => setActivation(undefined)}
        >
          <p>{activationMessage(activation)}</p>
          {!activation.replayed && activation.delivery === "manual" && activation.activationCode ? (
            <code className="lyx-staff-activation" aria-label="员工激活码">
              {activation.activationCode}
            </code>
          ) : null}
          <p>有效期至 {appDateTimeFormat.dateTime(activation.expiresAt)}</p>
          <div className="lyx-confirm__footer">
            <Button size="large" type="primary" onClick={() => setActivation(undefined)}>
              我已记下，关闭
            </Button>
          </div>
        </Modal>
      ) : null}
      {sessions ? (
        <StaffSessions
          services={services}
          staffId={staff.staffId}
          close={() => setSessions(false)}
        />
      ) : null}
    </>
  );
}
function DutyButton({
  services,
  staff,
  refresh,
}: {
  services: AppServices;
  staff: StaffDetail;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const onDuty = staff.poolMemberships.find((row) => row.pool === "cs")?.onDuty;
  if (onDuty === undefined) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>{onDuty ? "结束当班" : "开始当班"}</Button>
      {open ? (
        <ConfirmAction
          open
          action="staff-duty"
          spec={{
            title: onDuty ? "结束当班" : "开始当班",
            echo: [{ label: "员工", value: staff.name }],
            checkLabel: "我已核对当班状态",
          }}
          onCancel={() => setOpen(false)}
          onDone={() => setOpen(false)}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              await accessResult(
                await services.api.client.PATCH("/api/v1/admin/staff/{staffId}/duty", {
                  params: { path: { staffId: staff.staffId } },
                  body: { onDuty: !onDuty },
                  headers: { "Idempotency-Key": idempotencyKey },
                }),
              );
              await refresh();
              return { outcome: "done" };
            } catch (error) {
              return {
                outcome: "failed",
                message: error instanceof Error ? error.message : "当班更新失败",
              };
            }
          }}
        />
      ) : null}
    </>
  );
}
function StaffCommand({
  action,
  services,
  staff,
  roles,
  close,
  refresh,
  done,
  conflict,
}: {
  action: string;
  services: AppServices;
  staff: StaffDetail;
  roles: readonly Role[];
  close: () => void;
  refresh: () => Promise<void>;
  done: (value: unknown) => void;
  conflict: () => void;
}) {
  const scope = actorScope(useContext(AccessContext));
  const [draft, setDraft] = useState(() => commandDraft(staff));
  const [confirming, setConfirming] = useState(false),
    [message, setMessage] = useState<string>();
  const result = useRef<unknown>(undefined);
  const workNeeded = action === "disable" || action === "handover";
  const work = useQuery({
    queryKey: [...STAFF_LIST_KEY, scope, "work", staff.staffId],
    enabled: workNeeded,
    ...DETAIL_QUERY,
    queryFn: async () =>
      (await accessResult(
        await services.api.client.GET("/api/v1/admin/staff/{staffId}/open-work", {
          params: { path: { staffId: staff.staffId } },
        }),
      )) as unknown as OpenWork,
  });
  const groups = useQuery({
    queryKey: [...STAFF_LIST_KEY, scope, "groups", draft.roleKey],
    enabled: action === "update",
    queryFn: async () =>
      accessResult(
        await services.api.client.GET("/api/v1/admin/staff-groups", {
          params: { query: { roleKey: draft.roleKey } },
        }),
      ),
  });
  const update = (patch: Partial<StaffCommandDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setMessage(undefined);
  };
  const title = staffActionLabels[action] ?? "设置分配池";
  const canContinue =
    !workNeeded ||
    (workReady(work.data, draft.target, draft.reason, draft.note) &&
      (action !== "handover" || Boolean(draft.target)));
  const spec: ConfirmSpec = {
    title,
    description: "提交后由服务端重新校验权限、在办量与版本；请核对当前信息。",
    echo: [
      { label: "员工 / 工号", value: `${staff.name} / ${staff.staffNo}` },
      { label: "手机号", value: staff.phoneMask ?? "—" },
      ...(work.data
        ? [
            { label: "在办总量", value: String(work.data.total) },
            {
              label: "接收人",
              value:
                work.data.candidates.find((row) => row.staffId === draft.target)?.name ??
                "无需移交",
            },
          ]
        : []),
    ],
    checkLabel: "我已核对员工与操作影响",
    danger: action === "disable" || action.startsWith("reset"),
    ...(action === "disable" || action.startsWith("reset")
      ? {
          sensitive: { label: "请输入员工工号确认", expected: String(staff.staffNo) },
          seenValue: String(staff.staffNo),
        }
      : {}),
  };
  if (confirming)
    return (
      <ConfirmAction
        open
        action={`staff-${action}`}
        spec={spec}
        onCancel={() => setConfirming(false)}
        onDone={() => done(result.current)}
        onConfirm={async ({ idempotencyKey }) => {
          try {
            result.current = await sendStaffCommand(
              services,
              staff,
              action,
              draft,
              idempotencyKey,
              work.data,
            );
            await refresh();
            return { outcome: "done" };
          } catch (error) {
            if (
              error instanceof AccessFailure &&
              ["VERSION_CONFLICT", "CONFIRM_MISMATCH"].includes(error.failure.symbol)
            ) {
              await Promise.all([refresh(), workNeeded ? work.refetch() : Promise.resolve()]);
              conflict();
            }
            return {
              outcome: "failed",
              message: error instanceof Error ? error.message : "操作失败，请重试",
            };
          }
        }}
      />
    );
  return (
    <Modal
      open
      title={title}
      className="lyx-staff-command"
      footer={null}
      destroyOnHidden
      onCancel={close}
    >
      <p>
        {staff.name} · 工号 {staff.staffNo}
      </p>
      {action === "update" ? (
        <>
          <FormField label="姓名">
            {(props) => (
              <Input
                {...props}
                value={draft.name}
                maxLength={10}
                onChange={(event) => update({ name: event.target.value })}
              />
            )}
          </FormField>
          <FormField label="手机号（不可修改）">
            {(props) => <Input {...props} readOnly value={staff.phoneMask ?? "—"} />}
          </FormField>
          <FormField label="角色">
            {(props) => (
              <Select
                {...props}
                value={draft.roleKey}
                options={roles.map((row) => ({ value: String(row.roleKey), label: row.name }))}
                onChange={(roleKey: StaffCommandDraft["roleKey"]) =>
                  update({ roleKey, staffGroupId: "" })
                }
              />
            )}
          </FormField>
          <FormField label="分组">
            {(props) => (
              <Select
                {...props}
                value={draft.staffGroupId || undefined}
                loading={groups.isPending}
                options={groups.data?.items.map((row) => ({
                  value: row.staffGroupId,
                  label: row.name,
                }))}
                onChange={(staffGroupId: string) => update({ staffGroupId })}
              />
            )}
          </FormField>
          {groups.isError ? <Alert type="error" title={groups.error.message} /> : null}
          <Checkbox
            checked={draft.isLead}
            onChange={(event) => update({ isLead: event.target.checked })}
          >
            本岗位主管
          </Checkbox>
          <Checkbox
            checked={draft.ackNoLead}
            onChange={(event) => update({ ackNoLead: event.target.checked })}
          >
            已核对分组主管变化
          </Checkbox>
          <FormField label="对外称呼">
            {(props) => (
              <Input
                {...props}
                value={draft.displayName}
                maxLength={10}
                onChange={(event) => update({ displayName: event.target.value })}
              />
            )}
          </FormField>
          <FormField label="服务电话">
            {(props) => (
              <Input
                {...props}
                value={draft.servicePhone}
                maxLength={20}
                onChange={(event) => update({ servicePhone: event.target.value })}
              />
            )}
          </FormField>
        </>
      ) : null}
      {workNeeded ? (
        <>
          {work.isPending ? (
            <p aria-busy="true">正在读取当前在办与接收人…</p>
          ) : work.isError ? (
            <ErrorState message={work.error.message} onRetry={() => void work.refetch()} />
          ) : (
            <>
              <p>
                在办 {work.data.total} 项，发起待审 {work.data.pendingApprovalsAsRequester} 项
              </p>
              <ul>
                {work.data.bySource.map((row) => (
                  <li key={String(row.source)}>
                    {workSourceLabels[row.source] ?? "其他在办"}：{row.count} ·{" "}
                    {row.samples.map((item) => item.label).join("、")}
                  </li>
                ))}
              </ul>
              <FormField label="移交给">
                {(props) => (
                  <Select
                    {...props}
                    value={draft.target || undefined}
                    options={work.data.candidates.map((row) => ({
                      value: row.staffId,
                      label: row.name,
                    }))}
                    onChange={(target: string) => update({ target })}
                  />
                )}
              </FormField>
              {(work.data.total > 0 || action === "handover") && !work.data.candidates.length ? (
                <Alert type="warning" title="没有可接收的同角色启用员工，请先新增或启用接收人。" />
              ) : null}
            </>
          )}
          <FormField label="原因">
            {(props) => (
              <Select
                {...props}
                value={draft.reason}
                options={[
                  ...(action === "disable" ? [{ value: "resigned", label: "离职" }] : []),
                  { value: "reassigned", label: "调岗" },
                  { value: "long_leave", label: "长期休假" },
                  { value: "other", label: "其他" },
                ]}
                onChange={(reason: StaffCommandDraft["reason"]) => update({ reason })}
              />
            )}
          </FormField>
        </>
      ) : null}
      {["enable", "reissue-activation-code", "reset-password", "reset-mfa"].includes(action) ? (
        <>
          <FormField label="激活码交付">
            {(props) => (
              <Select
                {...props}
                value={draft.delivery}
                options={[
                  { value: "manual", label: "手动转交（一次性展示）" },
                  { value: "sms", label: "申请短信（以服务端实际结果为准）" },
                ]}
                onChange={(delivery: StaffCommandDraft["delivery"]) => update({ delivery })}
              />
            )}
          </FormField>
          <p>保持8位激活码和24小时有效期。短信未支持或未配时按实际结果手动转交。</p>
        </>
      ) : null}
      {action === "bind-wecom" ? (
        <>
          <FormField label="企业微信账号">
            {(props) => (
              <Input
                {...props}
                value={draft.wecomUserid}
                maxLength={64}
                onChange={(event) => update({ wecomUserid: event.target.value })}
              />
            )}
          </FormField>
          <Checkbox
            checked={draft.takeOver}
            onChange={(event) => update({ takeOver: event.target.checked })}
          >
            确认接管该账号（由服务端校验可接管条件）
          </Checkbox>
        </>
      ) : null}
      {action === "invite-wecom" ? <p>发送站内绑定邀请；不代表企业微信外部消息已送达。</p> : null}
      {action === "unlock" ? (
        <FormField label="解锁范围">
          {(props) => (
            <Select
              {...props}
              value={draft.bucket}
              options={[
                { value: "all", label: "全部" },
                { value: "trusted", label: "可信网络" },
                { value: "untrusted", label: "非可信网络" },
              ]}
              onChange={(bucket: StaffCommandDraft["bucket"]) => update({ bucket })}
            />
          )}
        </FormField>
      ) : null}
      {action === "pools" ? (
        <PoolEditor
          services={services}
          staffId={staff.staffId}
          roleKey={staff.roleKey}
          value={draft.memberships}
          change={(memberships) => update({ memberships })}
        />
      ) : null}
      {workNeeded || action.startsWith("reset") || action === "unlock" ? (
        <FormField label={draft.reason === "other" && workNeeded ? "说明（必填）" : "说明（选填）"}>
          {(props) => (
            <Input.TextArea
              {...props}
              value={draft.note}
              maxLength={200}
              onChange={(event) => update({ note: event.target.value })}
            />
          )}
        </FormField>
      ) : null}
      {message ? <Alert type="warning" title={message} role="alert" /> : null}
      <div className="lyx-confirm__footer">
        <Button size="large" onClick={close}>
          取消
        </Button>
        <Button
          size="large"
          type="primary"
          disabled={
            !canContinue ||
            (action === "update" && !draft.name.trim()) ||
            (action === "bind-wecom" && !draft.wecomUserid.trim())
          }
          onClick={() => setConfirming(true)}
        >
          核对并继续
        </Button>
      </div>
    </Modal>
  );
}
function PoolEditor({
  services,
  staffId,
  roleKey,
  value,
  change,
}: {
  services: AppServices;
  staffId: string;
  roleKey: string;
  value: StaffCommandDraft["memberships"];
  change: (value: StaffCommandDraft["memberships"]) => void;
}) {
  const scope = actorScope(useContext(AccessContext));
  const regions = useQuery({
    queryKey: [...STAFF_LIST_KEY, "regions"],
    queryFn: async () =>
      accessResult(
        await services.api.client.GET("/api/v1/admin/dict-items", {
          params: { query: { typeKey: "region" } },
        }),
      ),
  });
  const current = useQuery({
    queryKey: [...STAFF_LIST_KEY, scope, "pool-preview", staffId],
    ...DETAIL_QUERY,
    queryFn: async () =>
      accessResult(
        await services.api.client.GET("/api/v1/admin/assignment-pool-members", {
          params: { query: { staffId } },
        }),
      ),
  });
  const cities =
    regions.data?.items.filter(
      (item) =>
        item.isEnabled &&
        typeof item.ext === "object" &&
        item.ext !== null &&
        "level" in item.ext &&
        item.ext.level === 2 &&
        "opened" in item.ext &&
        item.ext.opened === true &&
        "functionalZone" in item.ext &&
        item.ext.functionalZone === false,
    ) ?? [];
  return (
    <>
      <p>整体替换该员工的分配池。城市来自市级字典；浏览推荐与游标不会推进轮询。</p>
      {regions.isError || current.isError ? (
        <Alert type="error" title={(regions.error ?? current.error)?.message} />
      ) : null}
      {value.map((row, index) => (
        <div key={index} className="lyx-access-actions">
          <Select
            aria-label={`分配池${index + 1}`}
            value={row.pool}
            options={ASSIGNMENT_POOL.values
              .filter((pool) => pool === roleKey)
              .map((pool) => ({
                value: pool,
                label: poolLabels[pool],
              }))}
            onChange={(pool: typeof row.pool) =>
              change(value.map((item, at) => (at === index ? { pool, cityCode: null } : item)))
            }
          />
          {row.pool === "delivery_manager" ? (
            <Select
              aria-label={`城市${index + 1}`}
              value={row.cityCode ?? undefined}
              loading={regions.isPending}
              options={cities.map((item) => ({ value: item.code, label: item.name }))}
              onChange={(cityCode: string) =>
                change(value.map((item, at) => (at === index ? { ...item, cityCode } : item)))
              }
            />
          ) : null}
          <Button danger onClick={() => change(value.filter((_, at) => at !== index))}>
            移除第{index + 1}项
          </Button>
        </div>
      ))}
      <Button
        disabled={value.length >= 20 || !ASSIGNMENT_POOL.values.some((pool) => pool === roleKey)}
        onClick={() => {
          const pool = ASSIGNMENT_POOL.values.find((pool) => pool === roleKey);
          if (pool) change([...value, { pool, cityCode: null }]);
        }}
      >
        增加分配池
      </Button>
      <ul aria-label="当前推荐和游标">
        {current.data?.items.map((row, index) => (
          <li key={index}>
            {poolLabels[String(row.pool)] ?? String(row.pool)} / {row.city?.name ?? "全域"}：
            {row.isRecommended ? "当前推荐" : "非当前推荐"}
          </li>
        ))}
      </ul>
      {current.data?.cursors.map((row) => (
        <p key={`${row.pool}:${row.scopeKey}`}>
          游标 {String(row.pool)}/{String(row.scopeKey)}：{row.lastStaff?.name ?? "尚未分配"}
        </p>
      ))}
    </>
  );
}
function StaffSessions({
  services,
  staffId,
  close,
}: {
  services: AppServices;
  staffId: string;
  close: () => void;
}) {
  const scope = actorScope(useContext(AccessContext));
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20),
    [activeOnly, setActive] = useState(true);
  const [revoke, setRevoke] = useState<StaffSession>(),
    [currentRevoked, setCurrentRevoked] = useState(false);
  const sessions = useQuery({
    queryKey: [...STAFF_LIST_KEY, scope, "sessions", staffId, page, pageSize, activeOnly],
    enabled: !currentRevoked,
    ...DETAIL_QUERY,
    queryFn: async () =>
      (await accessResult(
        await services.api.client.GET("/api/v1/admin/staff-sessions", {
          params: { query: { staffId, page, pageSize, activeOnly } },
        }),
      )) as unknown as { items: StaffSession[]; total: number },
  });
  return (
    <Modal open title="在线会话" footer={null} width={800} destroyOnHidden onCancel={close}>
      {currentRevoked ? (
        <Alert type="warning" title="当前会话已吊销，正在返回登录。" />
      ) : (
        <>
          <Checkbox
            checked={activeOnly}
            onChange={(event) => {
              setActive(event.target.checked);
              setPage(1);
            }}
          >
            仅有效会话
          </Checkbox>
          {sessions.isError ? (
            <ErrorState message={sessions.error.message} onRetry={() => void sessions.refetch()} />
          ) : (
            <>
              <Table<StaffSession>
                rowKey="staffSessionId"
                pagination={false}
                loading={sessions.isPending}
                dataSource={sessions.data?.items}
                columns={[
                  {
                    title: "网络 / 设备",
                    render: (_, row) => (
                      <span>
                        {row.ipMask ?? "—"} / {row.userAgent ?? "—"}
                      </span>
                    ),
                  },
                  {
                    title: "最近活跃",
                    render: (_, row) => appDateTimeFormat.dateTime(row.lastSeenAt),
                  },
                  {
                    title: "状态",
                    render: (_, row) =>
                      row.revokedAt ? "已吊销" : row.isCurrent ? "当前会话" : "有效",
                  },
                  {
                    title: "操作",
                    render: (_, row) =>
                      row.actions.includes("revoke") ? (
                        <Button danger size="small" onClick={() => setRevoke(row)}>
                          强制下线
                        </Button>
                      ) : (
                        "—"
                      ),
                  },
                ]}
              />
              <SimplePager
                total={sessions.data?.total ?? 0}
                page={page}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            </>
          )}
        </>
      )}
      {revoke ? (
        <ConfirmAction
          open
          action="staff-session-revoke"
          spec={{
            title: "强制下线",
            echo: [
              { label: "员工", value: revoke.staff.name },
              { label: "网络", value: revoke.ipMask ?? "—" },
              { label: "会话", value: revoke.isCurrent ? "当前登录会话" : "其他会话" },
            ],
            checkLabel: "我已核对需要吊销的会话",
            danger: true,
          }}
          onCancel={() => setRevoke(undefined)}
          onDone={() => setRevoke(undefined)}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              await accessResult(
                await services.api.client.POST(
                  "/api/v1/admin/staff-sessions/{staffSessionId}/revoke",
                  {
                    params: { path: { staffSessionId: revoke.staffSessionId } },
                    body: {},
                    headers: { "Idempotency-Key": idempotencyKey },
                  },
                ),
              );
              if (revoke.isCurrent) {
                setCurrentRevoked(true);
                // 使用原中央401恢复；不将失效会话留在可操作弹层，也不另存cookie/token。
                await services.api.client.GET("/api/v1/admin/auth/me");
              } else await sessions.refetch();
              return { outcome: "done" };
            } catch (error) {
              return {
                outcome: "failed",
                message: error instanceof Error ? error.message : "吊销失败，请重试",
              };
            }
          }}
        />
      ) : null}
    </Modal>
  );
}
