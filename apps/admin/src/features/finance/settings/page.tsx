import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Divider } from "antd";
import { useContext, useEffect, useState } from "react";
import { InfoList } from "../../../components/InfoList";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { readTableSearch, writeTableSearch } from "../../../lib/table-search";
import { refreshAdjustmentDetail } from "../credit-adjust/model";
import { financeScope } from "../payments/model";
import { configError, createConfigApi } from "./api";
import { ConfigDecisionPanel } from "./decision";
import { canPropose, configLabels, currentConfig, settingsSearch, stateLabels } from "./model";
import { ConfigPayload } from "./payload";
import { ProposeConfig } from "./propose";
import type { ConfigRevision } from "./types";

const route = getRouteApi("/finance/settings"),
  time = (value: string | null) => (value === null ? "—" : appDateTimeFormat.dateTimeFull(value));
export function FinanceSettingsPage() {
  return <SettingsWorkspace key={financeScope(useContext(AccessContext))} />;
}
function SettingsWorkspace() {
  const access = useContext(AccessContext),
    scope = financeScope(access),
    { services } = useRouteContext({ from: "__root__" }),
    api = createConfigApi(services),
    search = settingsSearch(route.useSearch()),
    navigate = route.useNavigate(),
    cache = useQueryClient(),
    prefix = ["finance", scope, "settings"] as const,
    currentKey = [...prefix, "current"],
    detailKey = [...prefix, "detail", search.id],
    [proposing, setProposing] = useState(false),
    current = useQuery({
      queryKey: currentKey,
      queryFn: ({ signal }) => api.list({ tab: "current" }, signal),
      ...DETAIL_QUERY,
    }),
    list = useQuery({
      queryKey: [...prefix, "list", search.tab, search.configKey, search.page, search.pageSize],
      queryFn: ({ signal }) =>
        api.list(
          {
            tab: search.tab,
            configKey: search.configKey,
            page: search.page,
            pageSize: search.pageSize,
          },
          signal,
        ),
      ...QUEUE_QUERY,
      placeholderData: undefined,
    }),
    detail = useQuery({
      queryKey: detailKey,
      queryFn: ({ signal }) => api.get(search.id!, signal),
      enabled: !!search.id,
      ...DETAIL_QUERY,
    });
  const select = (id: string | undefined) => void navigate({ search: { ...search, id } }),
    refreshCurrent = (signal: AbortSignal) =>
      refreshAdjustmentDetail(cache, currentKey, signal, (own) =>
        api.list({ tab: "current" }, own),
      ),
    changed = () => {
      void cache.invalidateQueries({ queryKey: [...prefix, "list"] });
    },
    refresh = async (signal: AbortSignal) => {
      await refreshCurrent(signal);
      return refreshAdjustmentDetail(cache, detailKey, signal, (own) => api.get(search.id!, own));
    };
  useEffect(() => {
    if (!list.data || list.isFetching || list.isError) return;
    const last =
      search.tab === "current" ? 1 : Math.max(1, Math.ceil(list.data.total / search.pageSize));
    if (search.page > last)
      void navigate({ search: { ...search, page: last, id: undefined }, replace: true });
  }, [list.data, list.isFetching, list.isError, search, navigate]);
  const columns: QueryColumn<ConfigRevision>[] = [
    {
      key: "config",
      title: "配置 / 说明",
      render: (row) => (
        <div className="lyx-cell-2">
          <strong>{configLabels[row.configKey]}</strong>
          <span className="lyx-cell-2__sub">{row.changeNote}</span>
        </div>
      ),
    },
    { key: "state", title: "状态", render: (row) => stateLabels[row.state] },
    { key: "requester", title: "提议人", render: (row) => row.approval.requester?.name ?? "—" },
    { key: "effective", title: "生效时间", render: (row) => time(row.effectiveAt) },
    {
      key: "detail",
      title: "详情",
      render: (row) => (
        <Button type="link" onClick={() => select(row.financeConfigRevisionId)}>
          查看配置
        </Button>
      ),
    },
  ];
  const value = detail.data,
    readableCurrent = current.isSuccess && !current.isError;
  return (
    <>
      <PageHeader
        title="受控财务配置"
        subtitle="提议、比对与异人审批；生效状态以当前服务端记录为准"
        extra={
          canPropose(access) ? (
            <Button
              type="primary"
              disabled={!readableCurrent || current.isFetching}
              onClick={() => setProposing(true)}
            >
              提议变更
            </Button>
          ) : undefined
        }
      />
      {current.isError ? (
        <Alert
          type="warning"
          title="当前生效配置读取失败，暂不可处理变更"
          action={<Button onClick={() => void current.refetch()}>重新读取生效配置</Button>}
        />
      ) : null}
      <MasterDetailPage
        label="财务配置主从详情"
        selectedKey={search.id}
        onSelect={select}
        detailTitle="配置详情与审批"
        onRetry={() => void detail.refetch()}
        detail={
          search.id
            ? detail.isPending
              ? { key: search.id, status: "loading" }
              : detail.isError
                ? { key: search.id, status: "error", message: configError(detail.error) }
                : {
                    key: search.id,
                    status: "ready",
                    content: value ? (
                      <div key={search.id}>
                        <InfoList
                          items={[
                            { label: "配置", value: configLabels[value.configKey] },
                            { label: "状态", value: stateLabels[value.state] },
                            { label: "提议人", value: value.approval.requester?.name ?? "—" },
                            { label: "审批人", value: value.approval.decidedBy?.name ?? "—" },
                            { label: "提议时间", value: time(value.createdAt) },
                            { label: "生效时间", value: time(value.effectiveAt) },
                            { label: "变更说明", value: value.changeNote },
                            { label: "处理说明", value: value.approval.decisionNote ?? "—" },
                          ]}
                        />
                        {value.state === "scheduled" ? (
                          <Alert type="info" title="已批准，尚未生效；等待期内仍沿用当前生效版本" />
                        ) : null}
                        <Divider>所选版本</Divider>
                        <ConfigPayload value={value} />
                        {readableCurrent ? (
                          <>
                            <Divider>当前生效值</Divider>
                            <ConfigPayload
                              value={currentConfig(current.data.items, value.configKey)}
                            />
                            <ConfigDecisionPanel
                              key={search.id}
                              value={value}
                              current={currentConfig(current.data.items, value.configKey)}
                              api={api}
                              refresh={refresh}
                              changed={changed}
                            />
                          </>
                        ) : null}
                      </div>
                    ) : null,
                  }
            : undefined
        }
        list={({ selectedKey, onSelect }) => (
          <QueryTablePage
            label="财务配置版本"
            search={readTableSearch(search, ["configKey"])}
            onSearchChange={(next) => {
              setProposing(false);
              void navigate({
                search: settingsSearch({ ...writeTableSearch(next), id: undefined }),
              });
            }}
            defaultTab="current"
            tabs={[
              { key: "current", label: "当前与待处理" },
              { key: "history", label: "全部版本" },
            ]}
            filters={[
              {
                key: "configKey",
                placeholder: "全部配置",
                options: Object.entries(configLabels).map(([value, label]) => ({ value, label })),
              },
            ]}
            columns={columns}
            rowKey={(row) => row.financeConfigRevisionId}
            selectedRowKey={selectedKey}
            onRowClick={(row) => onSelect(row.financeConfigRevisionId)}
            query={
              list.isPending
                ? { status: "loading" }
                : list.isError
                  ? { status: "error", message: configError(list.error) }
                  : { status: "success", items: list.data.items, total: list.data.total }
            }
            refreshing={list.isFetching}
            onRetry={() => void list.refetch()}
            empty={{ title: "暂无财务配置版本", filteredTitle: "没有符合条件的配置版本" }}
          />
        )}
      />
      {proposing && canPropose(access) && readableCurrent ? (
        <ProposeConfig
          items={current.data.items}
          api={api}
          refreshCurrent={refreshCurrent}
          onClose={() => setProposing(false)}
          onCreated={(id) => {
            setProposing(false);
            changed();
            void cache.invalidateQueries({ queryKey: currentKey });
            void navigate({
              search: { ...search, tab: "history", page: 1, configKey: undefined, id },
            });
          }}
        />
      ) : null}
    </>
  );
}
