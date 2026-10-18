import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Input, Modal, Select, Space } from "antd";
import { useContext, useEffect, useRef, useState } from "react";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { AccessContext, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { readTableSearch, writeTableSearch } from "../../../lib/table-search";
import { actorScope, writeIntent } from "../../system/staff-access";
import { createReferralApi, type ReferralApi, type ReferralRow } from "./api";
import {
  canManageReferral,
  referralAction,
  referralBody,
  referralQuery,
  referralSearch,
  REFERRAL_FILTERS,
  REFERRAL_KEY,
  sourceLabel,
  sourceOptions,
  statusLabel,
  statusOptions,
} from "./model";
import "./referral-codes.css";

const route = getRouteApi("/merchants/referral-codes");
export function ReferralCodesPage() {
  const access = useContext(AccessContext);
  return <ReferralWorkspace key={actorScope(access)} access={access} />;
}
function ReferralWorkspace({ access }: { access: AccessSnapshot | null }) {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate();
  const search = referralSearch(route.useSearch()),
    scope = actorScope(access),
    api = createReferralApi(services);
  const [creating, setCreating] = useState(false),
    [action, setAction] = useState<{ row: ReferralRow; kind: "enable" | "disable" }>(),
    [notice, setNotice] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: [...REFERRAL_KEY, scope, referralQuery(search)],
    queryFn: ({ signal }) => api.list(referralQuery(search), signal),
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const refresh = () =>
    services.queryClient.invalidateQueries({ queryKey: [...REFERRAL_KEY, scope] });
  const columns: QueryColumn<ReferralRow>[] = [
    { key: "code", title: "渠道码", render: (row) => <strong>{row.code}</strong> },
    { key: "source", title: "来源", render: (row) => sourceLabel(row.sourceType), width: 110 },
    {
      key: "owner",
      title: "归属员工",
      render: (row) =>
        row.owner ? (
          <Button
            type="link"
            onClick={() =>
              void navigate({
                search: referralSearch({ ...search, ownerStaffId: row.owner!.staffId, page: 1 }),
              })
            }
          >
            {row.owner.name}
            {row.owner.status === "disabled" ? "（已停用）" : ""}
          </Button>
        ) : (
          "—"
        ),
    },
    { key: "label", title: "说明", render: (row) => row.label || "—" },
    { key: "status", title: "状态", render: (row) => statusLabel(row.status), width: 90 },
    {
      key: "users",
      title: "注册用户",
      render: (row) => row.registeredUserCount,
      align: "right",
      width: 95,
    },
    {
      key: "entities",
      title: "归因主体",
      render: (row) => row.entityCount,
      align: "right",
      width: 95,
    },
    {
      key: "created",
      title: "创建时间",
      render: (row) => appDateTimeFormat.dateTimeFull(row.createdAt),
      width: 180,
    },
    {
      key: "action",
      title: "操作",
      render: (row) => {
        const kind = referralAction(access, row);
        return kind ? (
          <Button type="link" danger={kind === "disable"} onClick={() => setAction({ row, kind })}>
            {kind === "disable" ? "停用" : "启用"}
          </Button>
        ) : (
          "—"
        );
      },
      width: 75,
    },
  ];
  return (
    <>
      <PageHeader
        title="渠道码"
        subtitle="登记销售与活动来源，查看实际注册及主体归因。"
        extra={
          canManageReferral(access) ? (
            <Button type="primary" onClick={() => setCreating(true)}>
              登记渠道码
            </Button>
          ) : undefined
        }
      />
      {notice ? (
        <Alert type="success" title={notice} closable onClose={() => setNotice(undefined)} />
      ) : null}
      {search.ownerStaffId ? (
        <Alert
          type="info"
          title="当前按归属员工筛选"
          action={
            <Button
              onClick={() =>
                void navigate({
                  search: referralSearch({ ...search, ownerStaffId: undefined, page: 1 }),
                })
              }
            >
              清除员工筛选
            </Button>
          }
        />
      ) : null}
      <QueryTablePage
        label="渠道码列表"
        search={readTableSearch(search, REFERRAL_FILTERS)}
        onSearchChange={(next) => {
          setAction(undefined);
          void navigate({ search: referralSearch(writeTableSearch(next)) });
        }}
        keywordPlaceholder="搜索渠道码或说明"
        filters={[
          { key: "sourceType", placeholder: "全部来源", options: sourceOptions },
          { key: "status", placeholder: "全部状态", options: statusOptions },
        ]}
        columns={columns}
        rowKey={(row) => row.referralCodeId}
        query={
          query.isPending
            ? { status: "loading" }
            : query.isError
              ? { status: "error", message: query.error.message }
              : { status: "success", items: query.data.items, total: query.data.total }
        }
        refreshing={query.isFetching}
        onRetry={() => void query.refetch()}
        empty={{ title: "暂无渠道码", description: "登记后即可记录商家注册来源。" }}
      />
      {creating && canManageReferral(access) ? (
        <CreateReferral
          api={api}
          access={access}
          rows={query.data?.items ?? []}
          close={() => setCreating(false)}
          saved={async (row) => {
            await refresh();
            if (alive.current) {
              setCreating(false);
              setNotice(`渠道码 ${row.code} 已登记`);
            }
          }}
        />
      ) : null}
      {action && referralAction(access, action.row) === action.kind ? (
        <ConfirmAction
          key={`${action.row.referralCodeId}:${action.kind}`}
          open
          action={`referral-${action.kind}`}
          spec={{
            title: action.kind === "disable" ? "停用渠道码" : "启用渠道码",
            description:
              action.kind === "disable"
                ? "停用后不再接受新的注册归因，已有归因记录保留。"
                : "启用后可继续接受注册归因。",
            echo: [
              { label: "渠道码", value: action.row.code },
              { label: "来源", value: sourceLabel(action.row.sourceType) },
            ],
            checkLabel: "我已核对渠道码与操作",
            danger: action.kind === "disable",
          }}
          onCancel={() => setAction(undefined)}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              const row = await api[action.kind](action.row.referralCodeId, idempotencyKey);
              await refresh();
              if (alive.current) setNotice(`渠道码 ${row.code} 当前${statusLabel(row.status)}`);
              return { outcome: "done" };
            } catch (error) {
              await refresh();
              return {
                outcome: "failed",
                message: error instanceof Error ? error.message : "操作失败，请重试",
              };
            }
          }}
          onDone={() => {
            if (alive.current) setAction(undefined);
          }}
        />
      ) : null}
    </>
  );
}

function CreateReferral({
  api,
  access,
  rows,
  close,
  saved,
}: {
  api: ReferralApi;
  access: AccessSnapshot | null;
  rows: ReferralRow[];
  close(): void;
  saved(row: ReferralRow): Promise<void>;
}) {
  const [draft, setDraft] = useState({
    code: "",
    sourceType: "campaign" as "sales" | "campaign",
    ownerStaffId: "",
    label: "",
  });
  const [q, setQ] = useState(""),
    [ownerSearch, setOwnerSearch] = useState(""),
    [page, setPage] = useState(1),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const [intent] = useState(() => writeIntent("referral-create"));
  const alive = useRef(true),
    controller = useRef(new AbortController());
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    return () => {
      alive.current = false;
      controller.current.abort();
    };
  }, []);
  const listOwners = hasModuleLevel(access, "system");
  const owners = useQuery({
    queryKey: [...REFERRAL_KEY, actorScope(access), "owners", ownerSearch, page],
    queryFn: ({ signal }) => api.owners(ownerSearch, page, signal),
    enabled: listOwners && draft.sourceType === "sales",
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const visible = new Map<string, string>();
  if (access) visible.set(access.staff.id, access.staff.name);
  for (const row of rows)
    if (row.owner?.status === "active") visible.set(row.owner.staffId, row.owner.name);
  for (const owner of owners.data?.items ?? [])
    if (owner.status === "active") visible.set(owner.staffId, owner.name);
  const [chosen, setChosen] = useState<{ value: string; label: string }>();
  if (chosen) visible.set(chosen.value, chosen.label);
  const parsed = referralBody(draft);
  const submit = async () => {
    if (!parsed.success || !canManageReferral(access)) return;
    setPending(true);
    setError(undefined);
    try {
      const row = await intent.run(parsed.data, (key) =>
        api.create(parsed.data, key, controller.current.signal),
      );
      if (row && alive.current) await saved(row);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "登记失败，请重试");
    } finally {
      if (alive.current) setPending(false);
    }
  };
  return (
    <Modal
      open
      title="登记渠道码"
      onCancel={close}
      closable={!pending}
      maskClosable={!pending}
      keyboard={!pending}
      footer={
        <Space>
          <Button disabled={pending} onClick={close}>
            取消
          </Button>
          <Button
            type="primary"
            loading={pending}
            disabled={!parsed.success}
            onClick={() => void submit()}
          >
            登记
          </Button>
        </Space>
      }
    >
      <div className="lyx-referral-form">
        <label htmlFor="referral-code">渠道码</label>
        <Input
          id="referral-code"
          value={draft.code}
          maxLength={16}
          placeholder="4–16 位英文字母或数字"
          disabled={pending}
          onChange={(event) => setDraft({ ...draft, code: event.target.value })}
        />
        <label htmlFor="referral-source">来源</label>
        <Select
          id="referral-source"
          value={draft.sourceType}
          options={sourceOptions.filter((item) => item.value !== "partner")}
          disabled={pending}
          onChange={(sourceType: "sales" | "campaign") => setDraft({ ...draft, sourceType })}
        />
        {draft.sourceType === "sales" ? (
          <>
            <label htmlFor="referral-owner">归属员工</label>
            {listOwners ? (
              <Input.Search
                aria-label="搜索在职员工"
                value={q}
                maxLength={20}
                disabled={pending}
                onChange={(event) => setQ(event.target.value)}
                onSearch={(value) => {
                  setOwnerSearch(value.trim());
                  setPage(1);
                }}
              />
            ) : (
              <p>可选择当前可见的在职员工；其他员工请由有员工查看权限的人员登记。</p>
            )}
            <Select
              id="referral-owner"
              placeholder="选择归属员工"
              value={draft.ownerStaffId || undefined}
              disabled={pending}
              loading={owners.isFetching}
              options={[...visible].map(([value, label]) => ({ value, label }))}
              onChange={(value: string) => {
                setDraft({ ...draft, ownerStaffId: value });
                setChosen({ value, label: visible.get(value) ?? value });
              }}
            />
            {listOwners ? (
              <Space>
                <Button
                  disabled={pending || page === 1 || owners.isFetching}
                  onClick={() => setPage(page - 1)}
                >
                  上一页员工
                </Button>
                <Button
                  disabled={
                    pending || owners.isFetching || !owners.data || page * 20 >= owners.data.total
                  }
                  onClick={() => setPage(page + 1)}
                >
                  下一页员工
                </Button>
              </Space>
            ) : null}
            {owners.isError ? (
              <Alert
                type="error"
                title="员工列表加载失败"
                action={<Button onClick={() => void owners.refetch()}>重试</Button>}
              />
            ) : null}
          </>
        ) : null}
        <label htmlFor="referral-label">说明（选填）</label>
        <Input
          id="referral-label"
          value={draft.label}
          maxLength={30}
          disabled={pending}
          onChange={(event) => setDraft({ ...draft, label: event.target.value })}
        />
        {error ? <Alert type="error" title={error} /> : null}
      </div>
    </Modal>
  );
}
