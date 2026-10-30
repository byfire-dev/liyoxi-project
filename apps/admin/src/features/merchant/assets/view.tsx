import { STORE_ASSET_TYPE, STORE_ASSET_USABILITY } from "@liyoxi/contract";
import { formatDurationMs } from "@liyoxi/shared/format/duration";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Select, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import type { AppServices } from "../../../app/services";
import { InfoList } from "../../../components/InfoList";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { type AccessSnapshot } from "../../../lib/permissions";
import { DETAIL_QUERY, LIST_QUERY } from "../../../lib/query";
import { readTableSearch, writeTableSearch } from "../../../lib/table-search";
import { merchantScope, moment, status, text } from "../detail/model";
import { createAssetReadApi, type AssetDetail, type AssetRow } from "./api";
import { AssetActions } from "./actions";
import { AssetDemands } from "./demands";
import { createAssetDeleteReads } from "./delete-reads";
import { AssetEditor } from "./editor";
import { createAssetWriteApi } from "./write-api";
import { assetPermission, type AssetIntent } from "./write-model";
import {
  ASSET_FILTERS,
  ASSET_READ_KEY,
  adminLabels,
  assetListQuery,
  assetSearch,
  assetSummaryQuery,
  canReadAssets,
  fileKindLabel,
  insightLabels,
  processingLabels,
  selectedAsset,
  signedAssetUrl,
  typeLabels,
} from "./model";
interface AssetViewProps {
  services: AppServices;
  storeId: string;
  access: AccessSnapshot | null;
  search: Readonly<Record<string, unknown>>;
  change(next: Record<string, string>): void;
}
export function MerchantAssetsView(props: AssetViewProps) {
  const [notice, setNotice] = useState<string>();
  return (
    <MerchantAssetsContent
      key={`${merchantScope(props.access)}:${props.storeId}:${JSON.stringify(assetSearch(props.search))}`}
      {...props}
      notice={notice}
      setNotice={setNotice}
    />
  );
}
function MerchantAssetsContent({
  services,
  storeId,
  access,
  search,
  change,
  notice,
  setNotice,
}: AssetViewProps & {
  notice: string | undefined;
  setNotice(value: string | undefined): void;
}) {
  const wire = assetSearch(search),
    api = createAssetReadApi(services),
    writes = createAssetWriteApi(services),
    scope = merchantScope(access),
    permitted = canReadAssets(access);
  const context = JSON.stringify(wire),
    [intent, setIntent] = useState<{ id: string; value: AssetIntent; errorScope: string }>(),
    [, updateDetail] = useState(0),
    active = useRef(false),
    [deleteReads] = useState(() =>
      createAssetDeleteReads(services.queryClient, scope, storeId, wire.assetId, () =>
        updateDetail((value) => value + 1),
      ),
    );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const refresh = () =>
    services.queryClient.invalidateQueries({ queryKey: [...ASSET_READ_KEY, scope, storeId] });
  const rows = useQuery({
    queryKey: [...ASSET_READ_KEY, scope, storeId, "list", assetListQuery(storeId, wire)],
    queryFn: ({ signal }) => api.list(assetListQuery(storeId, wire), signal),
    enabled: permitted,
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const summary = useQuery({
    queryKey: [...ASSET_READ_KEY, scope, storeId, "summary", assetSummaryQuery(storeId, wire)],
    queryFn: ({ signal }) => api.summary(assetSummaryQuery(storeId, wire), signal),
    enabled: permitted,
    ...LIST_QUERY,
    placeholderData: undefined,
  });
  const picked =
    !rows.isError && !rows.isFetching
      ? selectedAsset(rows.data?.items, wire.assetId, storeId)
      : undefined;
  const detail = useQuery({
    queryKey: [...ASSET_READ_KEY, scope, storeId, "detail", picked?.storeAssetId, wire],
    queryFn: ({ signal }) => {
      if (!picked) throw new Error("请选择当前页可见素材");
      return api.detail(picked, storeId, signal);
    },
    enabled: () => permitted && !!picked && !deleteReads.paused(),
    ...DETAIL_QUERY,
    placeholderData: undefined,
  });
  const errorScope = `${rows.errorUpdatedAt}:${detail.errorUpdatedAt}`;
  const open = (value: AssetIntent) => setIntent({ id: crypto.randomUUID(), value, errorScope });
  if (!permitted) return <EmptyState title="当前没有商家素材查看权限" />;
  const columns: QueryColumn<AssetRow>[] = [
    {
      key: "title",
      title: "素材 / 上传人",
      render: (r) => (
        <span className="lyx-cell-2">
          {text(r.title)}
          <span className="lyx-cell-2__sub">
            {typeLabels[r.type]} · {text(r.uploader.displayName)} ·{" "}
            {r.uploader.actorType === "staff"
              ? "员工代传"
              : r.uploader.role === "clerk"
                ? "店员"
                : "老板"}
          </span>
        </span>
      ),
    },
    {
      key: "human",
      title: "人工整理 / 可用性",
      width: 170,
      render: (r) => (
        <span className="lyx-cell-2">
          {adminLabels[r.adminStatus]}
          <span className="lyx-cell-2__sub">
            {r.usability ? status(r.usability, "store_asset.usability") : "尚未人工确定"}
          </span>
        </span>
      ),
    },
    {
      key: "machine",
      title: "机器处理",
      width: 130,
      render: (r) => (
        <span className="lyx-cell-2">
          {processingLabels[r.processingState]}
          <span className="lyx-cell-2__sub">
            {r.isInsightPartial ? "结果不完整" : ""}
            {r.hasUnconfirmedAutoTags ? " · 标签待确认" : ""}
          </span>
        </span>
      ),
    },
    {
      key: "files",
      title: "文件 / 使用",
      width: 115,
      render: (r) => (
        <span className="lyx-cell-2">
          {r.fileCount} 个 / 采用 {r.adoptedCount}
          <span className="lyx-cell-2__sub">
            {r.durationMs === null
              ? r.pageCount === null
                ? r.charCount === null
                  ? "—"
                  : `${r.charCount} 字`
                : `${r.pageCount} 页`
              : formatDurationMs(r.durationMs)}
          </span>
        </span>
      ),
    },
    {
      key: "created",
      title: "上传时间",
      width: 170,
      render: (r) => moment(r.createdAt),
    },
  ];
  return (
    <section aria-label="门店素材">
      <p>机器识别仅供参考，素材用途、可用性和肖像授权须人工核对。</p>
      {notice ? (
        <Alert type="info" title={notice} closable onClose={() => setNotice(undefined)} />
      ) : null}
      <AssetDemands
        key={`${scope}:${storeId}:${context}`}
        api={writes}
        storeId={storeId}
        access={access}
        search={wire}
        change={change}
        upload={(demandId) => open({ kind: "create", storeId, demandId })}
        refresh={refresh}
        notice={setNotice}
      />
      {summary.isError ? (
        <ErrorState message={summary.error.message} onRetry={() => void summary.refetch()} />
      ) : null}
      <QueryTablePage
        label="门店素材列表"
        tabs={[
          {
            key: "all",
            label: "全部",
            count: summary.isSuccess ? summary.data.tabs.all : undefined,
          },
          {
            key: "organizing",
            label: "待整理",
            count: summary.isSuccess ? summary.data.tabs.organizing : undefined,
          },
          {
            key: "adopted",
            label: "已采用",
            count: summary.isSuccess ? summary.data.tabs.adopted : undefined,
          },
        ]}
        search={{ ...readTableSearch(wire, ASSET_FILTERS), tab: wire.assetTab }}
        onSearchChange={(next) =>
          change(assetSearch({ ...writeTableSearch(next), assetTab: next.tab, assetId: undefined }))
        }
        toolbar={
          <Space wrap>
            <Select
              aria-label="素材排序"
              value={wire.sort}
              style={{ width: 190 }}
              options={[
                { value: "-createdAt", label: "上传时间从新到旧" },
                { value: "reviewDueAt", label: "审核截止从早到晚" },
              ]}
              onChange={(sort: string) =>
                change(assetSearch({ ...wire, sort, assetId: undefined, page: 1 }))
              }
            />
            {rows.isSuccess &&
            !rows.isFetching &&
            assetPermission(access, "merchant.asset.upload_on_behalf") ? (
              <Button type="primary" onClick={() => open({ kind: "create", storeId })}>
                代传素材
              </Button>
            ) : null}
          </Space>
        }
        keywordPlaceholder="搜索素材标题或内容"
        filters={[
          {
            key: "type",
            placeholder: "素材类型",
            options: STORE_ASSET_TYPE.values.map((value) => ({ value, label: typeLabels[value] })),
          },
          {
            key: "usability",
            placeholder: "可用性",
            options: STORE_ASSET_USABILITY.values.map((value) => ({
              value,
              label: status(value, "store_asset.usability"),
            })),
          },
          {
            key: "hasPortraitAuthFiles",
            placeholder: "肖像材料",
            options: [
              { value: "true", label: "已有材料" },
              { value: "false", label: "未有材料" },
            ],
          },
        ]}
        columns={columns}
        rowKey={(r) => r.storeAssetId}
        selectedRowKey={picked?.storeAssetId}
        onRowClick={(r) => change(assetSearch({ ...wire, assetId: r.storeAssetId }))}
        query={
          rows.isPending
            ? { status: "loading" }
            : rows.isError
              ? { status: "error", message: rows.error.message }
              : { status: "success", items: rows.data?.items ?? [], total: rows.data?.total ?? 0 }
        }
        refreshing={rows.isFetching}
        onRetry={() => void rows.refetch()}
        empty={{ title: "暂无可见素材", filteredTitle: "没有符合条件的素材" }}
      />
      {wire.assetId ? (
        deleteReads.paused() ? (
          <p aria-busy="true">正在确认删除结果…</p>
        ) : !picked ? (
          <EmptyState
            title="所选素材不在当前页可见结果中"
            description="请从当前列表重新选择；不会请求其他门店的素材地址。"
          />
        ) : detail.isPending || detail.isFetching ? (
          <p aria-busy="true">正在读取素材详情…</p>
        ) : detail.isError ? (
          <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
        ) : (
          <>
            <AssetActions
              key={`actions:${scope}:${storeId}:${picked.storeAssetId}:${detail.dataUpdatedAt}`}
              row={detail.data}
              api={writes}
              access={access}
              open={open}
            />
            <AssetReadDetail
              key={`${scope}:${storeId}:${picked.storeAssetId}:${detail.dataUpdatedAt}`}
              row={detail.data}
              refresh={() => void detail.refetch()}
            />
          </>
        )
      ) : (
        <EmptyState title="选择一条素材查看详情" />
      )}
      {intent &&
      ((intent.value.kind === "delete" && deleteReads.paused()) ||
        (intent.errorScope === errorScope && !rows.isError && !detail.isError)) ? (
        <AssetEditor
          key={intent.id}
          intent={intent.value}
          api={writes}
          services={services}
          access={access}
          close={() => setIntent(undefined)}
          refresh={refresh}
          deleteReads={
            intent.value.kind === "delete"
              ? {
                  ...deleteReads,
                  async committed() {
                    await deleteReads.committed();
                    if (active.current) {
                      setIntent(undefined);
                      setNotice("素材已删除，已刷新列表");
                      change(assetSearch({ ...wire, assetId: undefined }));
                    }
                  },
                  async dismiss() {
                    if (active.current) {
                      setNotice("删除结果尚未确认，已返回素材列表。请刷新列表核对后再操作。");
                      change(assetSearch({ ...wire, assetId: undefined }));
                    }
                    await deleteReads.dismiss();
                  },
                }
              : undefined
          }
          notice={setNotice}
        />
      ) : null}
    </section>
  );
}
function AssetReadDetail({ row, refresh }: { row: AssetDetail; refresh(): void }) {
  const [now, setNow] = useState(Date.now);
  const deadlines = row.files
    .map((f) => f.expiresAt)
    .concat(row.thumbnail?.expiresAt ?? null)
    .filter((at): at is string => at !== null)
    .map(Date.parse)
    .filter((at) => Number.isFinite(at) && at > now);
  const nextExpiry = deadlines.length ? Math.min(...deadlines) : undefined;
  useEffect(() => {
    if (nextExpiry === undefined) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  return (
    <section className="lyx-merchant-item" aria-label="素材详情">
      <Space>
        <h3>{text(row.title)}</h3>
        <Button onClick={refresh}>刷新素材详情</Button>
      </Space>
      <InfoList
        labelWidth={110}
        items={[
          { label: "素材类型", value: typeLabels[row.type] },
          { label: "上传人", value: text(row.uploader.displayName) },
          { label: "上传时间", value: moment(row.createdAt) },
          { label: "备注", value: text(row.note, 500) },
          { label: "采用次数", value: row.adoptedCount },
        ]}
      />
      <h3>文件与正文</h3>
      {row.textBody !== null ? (
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.textBody}</p>
      ) : null}
      {row.files.map((file, index) => {
        const url = signedAssetUrl(file.url, file.expiresAt, now);
        return (
          <p key={file.fileId}>
            文件 {index + 1} · {fileKindLabel(file.kind)} ·{" "}
            {file.durationMs === null ? "时长未知" : formatDurationMs(file.durationMs)} ·{" "}
            {url ? (
              <a className="lyx-link" href={url} target="_blank" rel="noopener noreferrer">
                打开文件 {index + 1}
              </a>
            ) : (
              <span>暂无有效地址，请刷新素材详情</span>
            )}
          </p>
        );
      })}
      {!row.files.length && row.textBody === null ? <p>暂无正文或文件</p> : null}
      <h3>人工整理与授权事实</h3>
      <InfoList
        labelWidth={110}
        items={[
          { label: "整理状态", value: adminLabels[row.adminStatus] },
          {
            label: "人工可用性",
            value: row.usability ? status(row.usability, "store_asset.usability") : "尚未人工确定",
          },
          { label: "整理人", value: text(row.reviewedBy?.name) },
          { label: "整理时间", value: moment(row.reviewedAt) },
          {
            label: "肖像材料",
            value: `${row.portraitAuth.fileCount} 份（有材料不等于授权已确认）`,
          },
          { label: "授权确认", value: moment(row.portraitAuth.authorizedAt) },
          {
            label: "时效",
            value: row.timelinessTag
              ? `${row.timelinessTag.tag.name} · ${row.timelinessTag.validStartDate ?? "—"} — ${row.timelinessTag.validEndDate ?? "—"}`
              : "尚未人工确定",
          },
        ]}
      />
      <p>
        内容标签：
        {row.contentTags
          .map(
            (tag) =>
              `${tag.tag.name}（${tag.source === "auto" ? (tag.isConfirmed ? "机器建议已确认" : "机器建议未确认") : "人工"}）`,
          )
          .join("、") || "暂无"}
      </p>
      <p>用途标签：{row.usageTags.map((tag) => tag.tag.name).join("、") || "暂无人工用途"}</p>
      <h3>机器识别（仅供参考）</h3>
      <p>技术规格：{row.techSpecLabel ?? "暂无识别结果"}</p>
      <p>
        机器处理：{processingLabels[row.processingState]}
        {row.isInsightPartial ? " · 结果不完整，可人工整理" : ""}
      </p>
      {row.insightSteps.length ? (
        <ul>
          {row.insightSteps.map((step, index) => (
            <li key={`${step.kind}:${index}`}>
              {insightLabels[step.kind]}：
              {step.status === "ok" ? "已完成" : step.status === "failed" ? "失败" : "已跳过"}
            </li>
          ))}
        </ul>
      ) : (
        <p>暂无识别步骤结果，可人工整理</p>
      )}
      {row.transcript ? (
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.transcript.text}</p>
      ) : (
        <p>暂无识别全文</p>
      )}
      {row.keypoints.length ? (
        <ul>
          {row.keypoints.map((value, index) => (
            <li key={index}>{value}</li>
          ))}
        </ul>
      ) : null}
      {row.structuredItems.length ? (
        <ul>
          {row.structuredItems.map((item, index) => (
            <li key={index}>
              {item.name} · {item.priceText ?? "未识别价格"}
            </li>
          ))}
        </ul>
      ) : null}
      {row.suggestion ? (
        <>
          <p>机器描述：{row.suggestion.description ?? "暂无"}</p>
          <p>
            机器建议内容：{row.suggestion.contentTags.map((tag) => tag.name).join("、") || "暂无"}
          </p>
          <p>
            机器建议用途：{row.suggestion.usageTags.map((tag) => tag.name).join("、") || "暂无"}
          </p>
          <p>
            机器建议时效：
            {row.suggestion.timeliness
              ? `${row.suggestion.timeliness.tag.name} · ${row.suggestion.timeliness.validStartDate ?? "—"} — ${row.suggestion.timeliness.validEndDate ?? "—"}`
              : "暂无机器建议"}
          </p>
          <p>
            人脸提示：
            {row.suggestion.faceHint === "identifiable_customer"
              ? "可能存在可识别顾客，不能视为已获授权"
              : row.suggestion.faceHint === "people_unclear"
                ? "有人物但不清晰，仍需人工核对"
                : "未提示人脸，不代表已有授权"}
          </p>
          {row.suggestion.qualityNotes.map((value, index) => (
            <p key={index}>{value}</p>
          ))}
        </>
      ) : (
        <Alert type="info" title="暂无机器洞察，保持人工整理，不代表自动通过" />
      )}
      <h3>历史使用记录</h3>
      {row.usages.length ? (
        <ul>
          {row.usages.map((usage, index) => (
            <li key={`${usage.usedById}:${index}`}>
              {usage.usedByNo} · {usage.role === "adopted" ? "采用" : "参考"} · {moment(usage.at)}
            </li>
          ))}
        </ul>
      ) : (
        <p>暂无使用记录</p>
      )}
    </section>
  );
}
