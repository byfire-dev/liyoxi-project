import { STORE_ASSET_DEMAND_NOTIFY_SCOPE } from "@liyoxi/contract";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Select, Space } from "antd";
import { useState } from "react";
import { FormField } from "../../../components/FormField";
import { QueryTablePage } from "../../../components/QueryTablePage";
import type { AccessSnapshot } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { formError, merchantScope, moment, text } from "../detail/model";
import { AssetConfirm } from "./confirm";
import { ASSET_READ_KEY, assetSearch } from "./model";
import type { AssetDemand, AssetWriteApi, DemandQuery } from "./write-api";
import {
  assetPermission,
  canDemandAction,
  demandLabels,
  prepareDemand,
  type AssetPrepared,
  type DemandIntent,
} from "./write-model";

export function AssetDemands({
  api,
  storeId,
  access,
  search,
  change,
  upload,
  refresh,
  notice,
}: {
  api: AssetWriteApi;
  storeId: string;
  access: AccessSnapshot | null;
  search: Record<string, string>;
  change(value: Record<string, string>): void;
  upload(demandId: string): void;
  refresh(): Promise<unknown>;
  notice(value: string): void;
}) {
  const [selected, select] = useState<{ value: DemandIntent; errorAt: number }>();
  const query: DemandQuery = {
    storeId,
    page: Number(search.demandPage ?? 1),
    pageSize: Number(search.demandPageSize ?? 20),
    ...(search.demandStatus ? { status: search.demandStatus } : {}),
  };
  const rows = useQuery({
    queryKey: [...ASSET_READ_KEY, merchantScope(access), storeId, "demands", query],
    queryFn: ({ signal }) => api.demands(query, signal),
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const current = rows.isSuccess && !rows.isFetching;
  const intent = selected?.errorAt === rows.errorUpdatedAt ? selected.value : undefined;
  const setIntent = (value: DemandIntent | undefined) =>
    select(value ? { value, errorAt: rows.errorUpdatedAt } : undefined);
  return (
    <section aria-label="素材需求">
      <QueryTablePage<AssetDemand>
        label="素材需求列表"
        search={{
          tab: "demands",
          q: "",
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 20,
          filters: search.demandStatus ? { status: search.demandStatus } : {},
        }}
        onSearchChange={(next) =>
          change(
            assetSearch({
              ...search,
              assetId: undefined,
              demandPage: next.page,
              demandPageSize: next.pageSize,
              demandStatus: next.filters.status,
            }),
          )
        }
        toolbar={
          current && assetPermission(access, "merchant.asset.demand.create") ? (
            <Button onClick={() => setIntent({ kind: "create", storeId })}>发起素材需求</Button>
          ) : null
        }
        filters={[
          {
            key: "status",
            placeholder: "需求状态",
            options: [
              { value: "open", label: "进行中" },
              { value: "done", label: "已完成" },
              { value: "canceled", label: "已撤销" },
            ],
          },
        ]}
        columns={[
          {
            key: "title",
            title: "需求 / 拍摄说明",
            render: (r) => (
              <span className="lyx-cell-2">
                {text(r.title)}
                <span className="lyx-cell-2__sub">{text(r.shootingNote)}</span>
              </span>
            ),
          },
          {
            key: "due",
            title: "完成日期",
            render: (r) => (
              <>
                {r.dueDate}
                {r.isOverdue ? " · 已逾期" : ""}
              </>
            ),
          },
          {
            key: "status",
            title: "进度 / 已收到",
            render: (r) => (
              <>
                {r.status === "open" ? "进行中" : r.status === "done" ? "已完成" : "已撤销"} ·{" "}
                {r.receivedCount} 条
              </>
            ),
          },
          {
            key: "staff",
            title: "发起人 / 时间",
            render: (r) => (
              <span className="lyx-cell-2">
                {text(r.createdBy.name)}
                <span className="lyx-cell-2__sub">{moment(r.createdAt)}</span>
              </span>
            ),
          },
          {
            key: "actions",
            title: "操作",
            render: (r) => (
              <Space wrap>
                <Button
                  onClick={() =>
                    change(
                      assetSearch({
                        ...search,
                        assetDemandId: r.assetDemandId,
                        assetId: undefined,
                        page: 1,
                      }),
                    )
                  }
                >
                  查看响应素材
                </Button>
                {current && assetPermission(access, "merchant.asset.upload_on_behalf") ? (
                  <Button onClick={() => upload(r.assetDemandId)}>响应需求代传</Button>
                ) : null}
                {current && canDemandAction(access, r, "complete") ? (
                  <Button onClick={() => setIntent({ kind: "complete", row: r })}>
                    完成素材需求
                  </Button>
                ) : null}
                {current && canDemandAction(access, r, "cancel") ? (
                  <Button danger onClick={() => setIntent({ kind: "cancel", row: r })}>
                    撤销素材需求
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
        rowKey={(r) => r.assetDemandId}
        query={
          rows.isPending
            ? { status: "loading" }
            : rows.isError
              ? { status: "error", message: rows.error.message }
              : { status: "success", items: rows.data.items, total: rows.data.total }
        }
        refreshing={rows.isFetching}
        onRetry={() => void rows.refetch()}
        empty={{ title: "暂无素材需求" }}
      />
      {intent && !rows.isError ? (
        <DemandEditor
          key={intent.kind === "create" ? "create" : `${intent.kind}:${intent.row.assetDemandId}`}
          intent={intent}
          api={api}
          close={() => setIntent(undefined)}
          refresh={refresh}
          notice={notice}
        />
      ) : null}
    </section>
  );
}
function DemandEditor({
  intent,
  api,
  close,
  refresh,
  notice,
}: {
  intent: DemandIntent;
  api: AssetWriteApi;
  close(): void;
  refresh(): Promise<unknown>;
  notice(value: string): void;
}) {
  const [draft, setDraft] = useState({
      title: "",
      note: "",
      dueDate: "",
      notifyScope: "owner_and_clerks",
    }),
    [prepared, setPrepared] = useState<AssetPrepared>(),
    [error, setError] = useState<string>(),
    [today] = useState(() => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10));
  const title = demandLabels[intent.kind],
    row = intent.kind === "create" ? undefined : intent.row;
  if (prepared)
    return (
      <AssetConfirm
        prepared={prepared}
        api={api}
        close={close}
        refresh={refresh}
        notice={notice}
        spec={{
          title,
          danger: intent.kind === "cancel",
          echo: [
            { label: "需求", value: row?.title ?? draft.title },
            {
              label: "门店 ID",
              value: row?.storeId ?? (intent.kind === "create" ? intent.storeId : ""),
            },
            ...(row
              ? [{ label: "已收到", value: String(row.receivedCount) }]
              : [{ label: "完成日期", value: draft.dueDate }]),
          ],
          checkLabel: "我已核对当前需求和操作",
          description:
            intent.kind === "create"
              ? "通知由既有通知模块处理，本页不声明消息已送达。"
              : "以服务端当前需求状态为准。",
        }}
      />
    );
  return (
    <Modal open title={title} footer={null} onCancel={close} destroyOnHidden>
      {intent.kind === "create" ? (
        <>
          <FormField label="需求名称">
            {(p) => (
              <Input
                {...p}
                maxLength={20}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="拍摄说明（选填）">
            {(p) => (
              <Input.TextArea
                {...p}
                maxLength={200}
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="完成日期（北京时间）">
            {(p) => (
              <Input
                {...p}
                type="date"
                min={today}
                value={draft.dueDate}
                onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="通知对象">
            {(p) => (
              <Select
                {...p}
                style={{ width: "100%" }}
                value={draft.notifyScope}
                options={STORE_ASSET_DEMAND_NOTIFY_SCOPE.values.map((value) => ({
                  value,
                  label: value === "owner_only" ? "仅老板" : "老板和店员",
                }))}
                onChange={(notifyScope: string) => setDraft({ ...draft, notifyScope })}
              />
            )}
          </FormField>
        </>
      ) : intent.kind === "cancel" ? (
        <FormField label="撤销原因（选填）">
          {(p) => (
            <Input.TextArea
              {...p}
              maxLength={200}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          )}
        </FormField>
      ) : (
        <p>
          确认完成“{text(row?.title)}”，已收到 {row?.receivedCount ?? 0} 条。不会声明文件已经采用。
        </p>
      )}
      {error ? <Alert type="error" title={error} /> : null}
      <div className="lyx-confirm__footer">
        <Button onClick={close}>取消</Button>
        <Button
          type="primary"
          onClick={() => {
            try {
              setPrepared(prepareDemand(intent, draft));
            } catch (failure) {
              setError(formError(failure));
            }
          }}
        >
          保存并核对
        </Button>
      </div>
    </Modal>
  );
}
