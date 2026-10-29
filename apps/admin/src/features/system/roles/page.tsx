import "../staff-access.css";
import { permissionByKey } from "@liyoxi/contract/authz";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Radio, Select } from "antd";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppServices } from "../../../app/services";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { ReadOnlyValue } from "../../../components/ReadOnlyValue";
import { ErrorState } from "../../../components/StateBlock";
import { findModule } from "../../../lib/menu";
import { AccessContext, useCan } from "../../../lib/permissions";
import type { AdminModuleKey } from "../../../lib/menu-types";
import { DETAIL_QUERY, DICT_QUERY } from "../../../lib/query";
import { accessResult, actorScope, writeIntent } from "../staff-access";
import { scopeLabel, type Role } from "../staff-model";
import {
  levelLabels,
  allowsLeadLimit,
  ROLE_KEY,
  roleDraft,
  roleSearch,
  roleDirty,
  type RoleBody,
  type RoleDetail,
} from "./model";
import { replaceRole } from "./replace";

const route = getRouteApi("/sys/roles");
export function RolesPage() {
  const access = useContext(AccessContext);
  return <RoleWorkspace key={actorScope(access)} />;
}
function RoleWorkspace() {
  const scope = actorScope(useContext(AccessContext));
  const { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate(),
    search = roleSearch(route.useSearch());
  const canEdit = useCan("sys.role.edit");
  const [dirty, setDirty] = useState(false),
    [notice, setNotice] = useState<string>();
  const roles = useQuery({
    queryKey: [...ROLE_KEY, scope],
    ...DICT_QUERY,
    queryFn: async () =>
      (await accessResult(await services.api.client.GET("/api/v1/admin/roles")))
        .items as unknown as Role[],
  });
  const roleKey = search.role ?? roles.data?.[0]?.roleKey;
  const detail = useQuery({
    queryKey: [...ROLE_KEY, scope, roleKey],
    enabled: Boolean(roleKey),
    ...DETAIL_QUERY,
    queryFn: async () =>
      (await accessResult(
        await services.api.client.GET("/api/v1/admin/roles/{roleKey}", {
          params: { path: { roleKey: String(roleKey) } },
        }),
      )) as unknown as RoleDetail,
  });
  // The editor remounts when a global invalidation reads a new lockVersion.
  // Keep write completion here, while rejecting old actor/role/request contexts.
  const alive = useRef(true),
    request = useRef(0),
    context = useRef({ scope, roleKey });
  useLayoutEffect(() => {
    context.current = { scope, roleKey };
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [scope, roleKey]);
  const replace = (body: RoleBody, key: string) => {
    const started = context.current,
      sequence = ++request.current;
    return replaceRole(services, String(roleKey), body, key, {
      current: () => alive.current && context.current === started && request.current === sequence,
      conflict: async () => {
        setDirty(false);
        setNotice("角色已被他人修改，已刷新当前版本。请重新核对后编辑和保存。");
        await detail.refetch();
      },
      saved: async () => {
        setDirty(false);
        setNotice("角色已保存；员工刷新页面后生效。");
        await Promise.all([detail.refetch(), roles.refetch()]);
      },
    });
  };
  const select = (role: string | undefined) => {
    if (dirty && !window.confirm("放弃当前角色尚未保存的修改？")) return;
    if (role !== roleKey) request.current++;
    setDirty(false);
    setNotice(undefined);
    void navigate({ search: { role } });
  };
  return (
    <>
      <PageHeader title="角色权限" subtitle="按模块、敏感操作和数据范围配置；员工刷新后生效。" />
      {notice ? <Alert type="warning" title={notice} role="status" /> : null}
      {roles.isError ? (
        <ErrorState message={roles.error.message} onRetry={() => void roles.refetch()} />
      ) : (
        <MasterDetailPage
          label="角色权限"
          selectedKey={roleKey ? String(roleKey) : undefined}
          onSelect={select}
          onRetry={() => void detail.refetch()}
          detailTitle="角色配置"
          list={({ onSelect }) => (
            <section className="lyx-card lyx-access-list">
              {roles.isPending ? (
                <p aria-busy="true">正在读取角色…</p>
              ) : (
                <ul className="lyx-access-dict-list">
                  {roles.data?.map((role) => (
                    <li key={String(role.roleKey)}>
                      <button
                        className="lyx-focusable lyx-access-dict-item"
                        aria-pressed={role.roleKey === roleKey}
                        onClick={() => onSelect(String(role.roleKey))}
                      >
                        <span>
                          <strong>{role.name}</strong>
                          <span className="lyx-access-help">{role.description}</span>
                        </span>
                        <span>
                          {role.memberCount}人 ·{" "}
                          {role.isLocked ? "锁定" : scopeLabel(String(role.dataScope))}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          detail={
            roleKey
              ? detail.isPending
                ? { key: String(roleKey), status: "loading" }
                : detail.isError
                  ? { key: String(roleKey), status: "error", message: detail.error.message }
                  : detail.data
                    ? {
                        key: String(roleKey),
                        status: "ready",
                        content: (
                          <RoleEditor
                            key={`${roleKey}:${detail.data.lockVersion}`}
                            services={services}
                            role={detail.data}
                            canEdit={canEdit && !detail.data.isLocked}
                            dirtyChange={setDirty}
                            replace={replace}
                          />
                        ),
                      }
                    : { key: String(roleKey), status: "empty" }
              : undefined
          }
        />
      )}
    </>
  );
}
function RoleEditor({
  services,
  role,
  canEdit,
  dirtyChange,
  replace,
}: {
  services: AppServices;
  role: RoleDetail;
  canEdit: boolean;
  dirtyChange: (value: boolean) => void;
  replace: (body: RoleBody, key: string) => Promise<boolean | undefined>;
}) {
  const [draft, setDraft] = useState(() => roleDraft(role));
  const [editing, setEditing] = useState(false),
    [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [intent] = useState(() => writeIntent("role-replace"));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const dirty = roleDirty(draft, roleDraft(role)),
    readonly = !canEdit || !editing || pending;
  const change = (next: typeof draft) => {
    setDraft(next);
    dirtyChange(roleDirty(next, roleDraft(role)));
  };
  return (
    <>
      <ReadOnlyValue label="角色" value={role.name} />
      <ReadOnlyValue label="职责" value={role.description} />
      <ReadOnlyValue
        label="成员"
        value={role.members.map((staff) => staff.name).join("、") || "暂无成员"}
      />
      <p>
        {role.isLocked
          ? "超级管理员配置锁定，不可编辑。"
          : !canEdit
            ? "当前权限只读。"
            : dirty
              ? "有未保存的修改"
              : role.isDefault
                ? "当前为默认配置"
                : "已保存"}
      </p>
      <table className="lyx-permission-matrix" aria-label="模块权限">
        <thead>
          <tr>
            <th>模块</th>
            <th>访问等级</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(draft.moduleLevels).map(([key, level]) => (
            <tr key={key}>
              <th>{findModule(key as AdminModuleKey).title}</th>
              <td>
                <Radio.Group
                  aria-label={`${findModule(key as AdminModuleKey).title}权限`}
                  value={level}
                  disabled={readonly}
                  options={Object.entries(levelLabels)
                    .filter(([value]) => value !== "o" || key === "delivery" || key === "publish")
                    .map(([value, label]) => ({ value, label }))}
                  onChange={(event) =>
                    change({
                      ...draft,
                      moduleLevels: {
                        ...draft.moduleLevels,
                        [key]: event.target.value as RoleBody["moduleLevels"][AdminModuleKey],
                      },
                    })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>敏感操作</h3>
      {Object.entries(draft.actions).map(([key, action]) => (
        <div key={key} className="lyx-access-actions">
          <Checkbox
            checked={action.on}
            disabled={readonly}
            onChange={(event) =>
              change({
                ...draft,
                actions: { ...draft.actions, [key]: { ...action, on: event.target.checked } },
              })
            }
          >
            {permissionByKey(key)?.name ?? key}
          </Checkbox>
          <Checkbox
            checked={action.leadOnly}
            disabled={readonly || !action.on || !allowsLeadLimit(key)}
            onChange={(event) =>
              change({
                ...draft,
                actions: { ...draft.actions, [key]: { ...action, leadOnly: event.target.checked } },
              })
            }
          >
            仅主管
          </Checkbox>
        </div>
      ))}
      <label>
        数据范围{" "}
        <Select
          aria-label="数据范围"
          value={draft.dataScope}
          disabled={readonly}
          options={["own", "group", "all"].map((value) => ({ value, label: scopeLabel(value) }))}
          onChange={(value: RoleBody["dataScope"]) => change({ ...draft, dataScope: value })}
        />
      </label>
      {message ? <Alert type="error" title={message} role="alert" /> : null}
      {canEdit ? (
        <div className="lyx-confirm__footer">
          {!editing ? (
            <Button size="large" onClick={() => setEditing(true)}>
              编辑权限
            </Button>
          ) : (
            <>
              <Button
                disabled={pending}
                onClick={() => {
                  change(roleDraft(role));
                  setEditing(false);
                }}
              >
                取消修改
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setMessage(undefined);
                  void (async () => {
                    const defaults = await accessResult(
                      await services.api.client.GET("/api/v1/admin/roles/{roleKey}/defaults", {
                        params: { path: { roleKey: String(role.roleKey) } },
                      }),
                    );
                    if (alive.current) change(roleDraft(defaults));
                  })()
                    .catch((error: unknown) => {
                      if (alive.current)
                        setMessage(error instanceof Error ? error.message : "默认配置读取失败");
                    })
                    .finally(() => {
                      if (alive.current) setPending(false);
                    });
                }}
              >
                恢复默认
              </Button>
              <Button
                size="large"
                type="primary"
                loading={pending}
                disabled={!dirty || pending}
                onClick={() => {
                  setPending(true);
                  setMessage(undefined);
                  const body = { ...draft, lockVersion: role.lockVersion };
                  void intent
                    .run(body, (key) => replace(body, key))
                    .then((result) => {
                      if (alive.current && result) setEditing(false);
                    })
                    .catch((error: unknown) => {
                      if (alive.current)
                        setMessage(error instanceof Error ? error.message : "保存失败，请重试");
                    })
                    .finally(() => {
                      if (alive.current) setPending(false);
                    });
                }}
              >
                保存权限
              </Button>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
