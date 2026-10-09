import "./staff-access.css";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, Modal, Select } from "antd";
import { useContext, useEffect, useRef, useState, type FormEvent } from "react";

import type { AppServices } from "../../app/services";
import { FormField } from "../../components/FormField";
import { PageHeader } from "../../components/PageHeader";
import { QueryTablePage, type QueryColumn, type QueryState } from "../../components/QueryTablePage";
import { StatusTag } from "../../components/StatusTag";
import { readFailure } from "../../lib/api-errors";
import { AccessContext, Can } from "../../lib/permissions";
import { DETAIL_QUERY, DICT_QUERY, LIST_QUERY } from "../../lib/query";
import { toListQuery, writeTableSearch } from "../../lib/table-search";

import {
  canActivateRole,
  createStaffIntent,
  creationView,
  scopeLabel,
  staffBody,
  staffLabel,
  staffSearch,
  STAFF_LIST_KEY,
  STAFF_ROLES_KEY,
  type CreationView,
  type Role,
  type StaffDraft,
  type StaffRow,
  type StaffResult,
} from "./staff-model";
import { StaffDrawer } from "./staff-detail";
import { accessResult, actorScope } from "./staff-access";

const route = getRouteApi("/sys/staff");
const WECOM_LABELS: Record<string, string> = {
  none: "未绑定",
  invited: "已邀请",
  bound: "已绑定",
  unbound: "已解绑",
};
function staffColumns(
  roles: readonly Role[],
  open: (staffId: string) => void,
): QueryColumn<StaffRow>[] {
  return [
    {
      key: "staff",
      title: "员工与工号",
      render: (row) => (
        <div className="lyx-staff-person">
          <span className="lyx-user__avatar" aria-hidden="true">
            {row.name.slice(0, 1)}
          </span>
          <span className="lyx-cell-2">
            <span className="lyx-cell-2__main lyx-cell-2__main--strong">{row.name}</span>
            <span className="lyx-cell-2__sub">{row.staffNo}</span>
          </span>
        </div>
      ),
    },
    {
      key: "role",
      title: "角色",
      width: 130,
      render: (row) => (
        <div className="lyx-cell-2">
          <span>{roles.find((role) => role.roleKey === row.roleKey)?.name ?? row.roleKey}</span>
          {row.isLead ? <span className="lyx-cell-2__sub">主管</span> : null}
        </div>
      ),
    },
    {
      key: "phone",
      title: "手机号",
      width: 164,
      mask: true,
      render: (row) => <span className="lyx-num">{row.phoneMask ?? "—"}</span>,
    },
    {
      key: "wecom",
      title: "企业微信",
      width: 88,
      render: (row) => WECOM_LABELS[row.wecomBindStatus] ?? "—",
    },
    { key: "scope", title: "数据范围", width: 100, render: (row) => scopeLabel(row.dataScope) },
    {
      key: "status",
      title: "状态",
      width: 90,
      render: (row) => {
        const tone = statusToneByEnum("staff.status", row.status)?.admin;
        return tone ? <StatusTag tone={tone.tone}>{staffLabel(row)}</StatusTag> : staffLabel(row);
      },
    },
    {
      key: "lastLogin",
      title: "最近登录",
      width: 144,
      render: (row) => (
        <div className="lyx-cell-2">
          <span className="lyx-num">
            {row.lastLoginAt ? appDateTimeFormat.dateTime(row.lastLoginAt) : "从未登录"}
          </span>
          {row.isSelf ? <span className="lyx-cell-2__sub">当前登录</span> : null}
        </div>
      ),
    },
    {
      key: "actions",
      title: "操作",
      width: 100,
      align: "right",
      render: (row) => (
        <Button type="link" size="small" onClick={() => open(row.staffId)}>
          查看 / 操作
        </Button>
      ),
    },
  ];
}

export function StaffPage() {
  const access = useContext(AccessContext);
  return <StaffWorkspace key={actorScope(access)} />;
}
function StaffWorkspace() {
  const scope = actorScope(useContext(AccessContext));
  const { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate();
  const search = staffSearch(route.useSearch());
  const listQuery = toListQuery(search);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreationView>();
  const [staffId, setStaffId] = useState<string>();
  const { q } = search;
  const { roleKey, status } = search.filters;
  const counts = useQuery({
    queryKey: [...STAFF_LIST_KEY, scope, "summary", { q, roleKey, status }],
    ...DETAIL_QUERY,
    queryFn: async () =>
      accessResult(
        await services.api.client.GET("/api/v1/admin/staff/summary", {
          params: { query: { q, roleKey, status } },
        }),
      ),
  });
  const list = useQuery({
    queryKey: [...STAFF_LIST_KEY, scope, listQuery],
    queryFn: async () => {
      const { data, response } = await services.api.client.GET("/api/v1/admin/staff", {
        params: { query: listQuery },
      });
      if (!data) throw new Error((await readFailure(response)).message);
      // openapi-fetch 的 Readable 映射会把开放枚举 string & {} 展开；JSON 使用契约线类型。
      return data.data as unknown as { items: StaffRow[]; total: number };
    },
    ...LIST_QUERY,
  });
  const roles = useQuery({
    queryKey: [...STAFF_ROLES_KEY, scope],
    queryFn: async () => {
      const { data, response } = await services.api.client.GET("/api/v1/admin/roles");
      if (!data) throw new Error((await readFailure(response)).message);
      return data.data.items as unknown as Role[];
    },
    ...DICT_QUERY,
  });
  const query: QueryState<StaffRow> =
    list.status === "pending"
      ? { status: "loading" }
      : list.status === "error"
        ? { status: "error", message: list.error.message }
        : { status: "success", items: list.data.items, total: list.data.total };
  return (
    <>
      <PageHeader
        title="员工账号"
        subtitle="管理后台员工的登录账号、角色与企业微信绑定。"
        extra={
          <Can action="sys.staff.manage">
            <Button type="primary" onClick={() => setCreating(true)}>
              ＋ 新增员工
            </Button>
          </Can>
        }
      />
      {counts.isError ? (
        <Alert
          type="error"
          title={counts.error.message}
          action={<Button onClick={() => void counts.refetch()}>重试计数</Button>}
        />
      ) : (
        <section
          className="lyx-card lyx-access-actions"
          aria-label="员工计数"
          aria-busy={counts.isPending}
        >
          {counts.data ? (
            <>
              <span>全部 {counts.data.total}</span>
              <span>启用 {counts.data.byStatus.active}</span>
              <span>待启用 {counts.data.byStatus.pending}</span>
              <span>已禁用 {counts.data.byStatus.disabled}</span>
              <span>待激活 {counts.data.pendingActivation}</span>
              <span>已锁定 {counts.data.locked}</span>
            </>
          ) : (
            "正在读取计数…"
          )}
        </section>
      )}
      <QueryTablePage<StaffRow>
        label="员工账号"
        search={search}
        onSearchChange={(next) =>
          void navigate({ search: writeTableSearch(staffSearch(writeTableSearch(next))) })
        }
        keywordPlaceholder="搜索姓名或手机号后 4 位"
        filters={[
          {
            key: "roleKey",
            placeholder: "全部角色",
            options: (roles.data ?? []).map((role) => ({ value: role.roleKey, label: role.name })),
          },
          {
            key: "status",
            placeholder: "全部状态",
            options: [
              { value: "active", label: "启用" },
              { value: "pending", label: "待启用" },
              { value: "disabled", label: "已禁用" },
            ],
          },
        ]}
        columns={staffColumns(roles.data ?? [], setStaffId)}
        onRowClick={(row) => setStaffId(row.staffId)}
        rowKey={(row) => row.staffId}
        query={query}
        refreshing={list.isFetching && list.status !== "pending"}
        onRetry={() => void list.refetch()}
        empty={{ title: "暂无员工", filteredTitle: "没有符合条件的员工" }}
      />
      {staffId ? (
        <StaffDrawer
          key={staffId}
          staffId={staffId}
          services={services}
          roles={roles.data ?? []}
          close={() => setStaffId(undefined)}
        />
      ) : null}
      <Can action="sys.staff.manage">
        {creating ? (
          roles.data ? (
            <CreateStaff
              services={services}
              roles={roles.data}
              onClose={() => setCreating(false)}
              onCreated={(view) => {
                setCreating(false);
                setCreated(view);
                void navigate({ search: {} });
                void services.queryClient.invalidateQueries({ queryKey: STAFF_LIST_KEY });
              }}
            />
          ) : (
            <Modal open centered title="新增员工" footer={null} onCancel={() => setCreating(false)}>
              {roles.isError ? (
                <>
                  <Alert type="error" title={roles.error.message} role="alert" />
                  <Button onClick={() => void roles.refetch()}>重试</Button>
                </>
              ) : (
                <p role="status">正在读取角色…</p>
              )}
            </Modal>
          )
        ) : null}
      </Can>
      {created ? (
        <Modal
          open
          centered
          title={created.code ? "员工激活码" : "员工已创建"}
          onCancel={() => setCreated(undefined)}
          destroyOnHidden
          footer={null}
        >
          <p>
            {created.name}：{created.message}
          </p>
          {created.code ? (
            <>
              <code className="lyx-staff-activation" aria-label="员工激活码">
                {created.code}
              </code>
              <p>
                有效期至 {created.expiresAt ? appDateTimeFormat.dateTime(created.expiresAt) : "—"}
              </p>
            </>
          ) : null}
          <div className="lyx-confirm__footer">
            <Button size="large" type="primary" onClick={() => setCreated(undefined)}>
              {created.code ? "我已记下，关闭" : "关闭"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function CreateStaff({
  services,
  roles,
  onClose,
  onCreated,
}: {
  services: AppServices;
  roles: Role[];
  onClose: () => void;
  onCreated: (view: CreationView) => void;
}) {
  const access = useContext(AccessContext);
  const partner = access?.releases["release.partner"] === true;
  const [draft, setDraft] = useState<StaffDraft>({
    name: "",
    phone: "",
    roleKey: "",
    isLead: false,
    activateNow: true,
  });
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [error, setError] = useState<string>();
  const [errors, setErrors] = useState<ReturnType<typeof staffBody>["errors"]>({});
  const [intent] = useState(() =>
    createStaffIntent(async (body, key) => {
      const { data, response } = await services.api.client.POST("/api/v1/admin/staff", {
        body,
        headers: { "Idempotency-Key": key },
      });
      if (!data) throw new Error((await readFailure(response)).message);
      return data.data as unknown as StaffResult;
    }),
  );
  const role = roles.find((item) => item.roleKey === draft.roleKey);
  const activateAllowed = canActivateRole(role, partner);
  const update = (patch: Partial<StaffDraft>) => {
    intent.change();
    setError(undefined);
    setErrors({});
    setDraft((current) => ({ ...current, ...patch }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (intent.pending) return;
    const checked = staffBody(draft, roles, partner);
    setErrors(checked.errors);
    if (!checked.body) return;
    setPending(true);
    setError(undefined);
    void intent
      .submit(checked.body)
      .then((result) => {
        if (alive.current && result) onCreated(creationView(result));
      })
      .catch((cause: unknown) => {
        if (alive.current)
          setError(cause instanceof Error ? cause.message : "请求没有成功，请重试");
      })
      .finally(() => {
        if (alive.current) setPending(false);
      });
  };
  return (
    <Modal
      open
      centered
      title="新增员工"
      width={560}
      footer={null}
      destroyOnHidden
      closable={!pending}
      mask={{ closable: !pending }}
      keyboard={!pending}
      onCancel={onClose}
    >
      <p>立即启用后生成激活码，只展示一次，请线下转交给员工。</p>
      <form aria-label="新增员工" className="lyx-auth-form" onSubmit={submit}>
        <div className="lyx-staff-form-grid">
          <FormField label="姓名" value={draft.name} maxLength={10} error={errors.name}>
            {(props) => (
              <Input
                {...props}
                value={draft.name}
                maxLength={10}
                required
                disabled={pending}
                placeholder="真实姓名"
                onChange={(event) => update({ name: event.target.value })}
              />
            )}
          </FormField>
          <FormField label="手机号" value={draft.phone} maxLength={11} error={errors.phone}>
            {(props) => (
              <Input
                {...props}
                value={draft.phone}
                maxLength={11}
                required
                disabled={pending}
                inputMode="tel"
                pattern="1[0-9]{10}"
                placeholder="用于登录"
                onChange={(event) => update({ phone: event.target.value })}
              />
            )}
          </FormField>
          <FormField label="角色" error={errors.roleKey}>
            {(props) => (
              <Select
                {...props}
                value={draft.roleKey || undefined}
                placeholder="请选择角色"
                disabled={pending}
                options={roles.map((item) => ({
                  value: item.roleKey,
                  label: item.availableFrom === "v1.1" ? `${item.name}（V1.1）` : item.name,
                }))}
                onChange={(roleKey: string) =>
                  update({
                    roleKey,
                    activateNow: canActivateRole(
                      roles.find((item) => item.roleKey === roleKey),
                      partner,
                    ),
                  })
                }
              />
            )}
          </FormField>
          <FormField label="数据范围">
            {(props) => (
              <Input
                {...props}
                readOnly
                value={
                  role
                    ? scopeLabel(
                        role.dataScope === "own" && draft.isLead ? "group" : role.dataScope,
                      )
                    : "—"
                }
              />
            )}
          </FormField>
        </div>
        <Checkbox
          checked={draft.isLead}
          disabled={pending}
          onChange={(event) => update({ isLead: event.target.checked })}
        >
          设为本岗位主管
        </Checkbox>
        <Checkbox
          checked={draft.activateNow}
          disabled={pending || (Boolean(role) && !activateAllowed)}
          onChange={(event) => update({ activateNow: event.target.checked })}
        >
          立即启用并生成激活码
        </Checkbox>
        {role && !activateAllowed ? (
          <p className="lyx-auth-hint">这个角色尚未开放，目前只能暂不启用。</p>
        ) : null}
        {error ? <Alert type="error" title={error} showIcon role="alert" /> : null}
        <div className="lyx-auth-modal-actions">
          <Button size="large" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            size="large"
            type="primary"
            htmlType="submit"
            disabled={pending}
            loading={pending}
          >
            创建账号
          </Button>
        </div>
      </form>
    </Modal>
  );
}
