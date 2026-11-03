import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Input, Select } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AppServices } from "../../../app/services";
import { FormField } from "../../../components/FormField";
import { ErrorState } from "../../../components/StateBlock";
import { UploadField } from "../../../components/UploadField";
import { AccessContext, useCan } from "../../../lib/permissions";
import { DETAIL_QUERY } from "../../../lib/query";
import { actorScope } from "../../system/staff-access";
import type { DetailApi, Ticket } from "./api";
import {
  createPublishApi,
  publishError,
  type PublishApi,
  type PublishList,
  type PublishReplace,
} from "./publish-api";
import { lockReason, nullableText, publishInput } from "./publish-list-model";
import { PackPanel } from "./pack-panel";
import { usePublishWrite } from "./publish-write";
import { createProductionUpload } from "./upload";
const coverRule = { accept: [".jpg", ".jpeg", ".png"], maxSizeMb: 5 };
function Cover({
  api,
  storeId,
  disabled,
  onChange,
  onBusy,
}: {
  api: DetailApi;
  storeId: string;
  disabled: boolean;
  onChange(id: string | null): void;
  onBusy(value: boolean): void;
}) {
  const adapter = useRef<ReturnType<typeof createProductionUpload> | null>(null);
  useEffect(() => {
    adapter.current = createProductionUpload(api, { category: "ticket_attachment", storeId });
    return () => {
      adapter.current?.dispose();
      adapter.current = null;
    };
  }, [api, storeId]);
  return (
    <UploadField
      rule={coverRule}
      text="上传清单封面"
      disabled={disabled}
      preserveValueOnFailure
      upload={async (file, hooks) => {
        if (!adapter.current) throw new Error("上传尚未就绪");
        onBusy(true);
        try {
          return await adapter.current.upload(file, hooks);
        } finally {
          if (adapter.current) onBusy(false);
        }
      }}
      onChange={onChange}
    />
  );
}
export function PublishListPanel({
  ticket,
  services,
  detailApi,
}: {
  ticket: Ticket;
  services: AppServices;
  detailApi: DetailApi;
}) {
  const scope = actorScope(useContext(AccessContext)),
    api = useMemo(() => createPublishApi(services), [services]);
  const query = useQuery({
    queryKey: ["publish-list", scope, ticket.deliveryTicketId],
    queryFn: ({ signal }) => api.get(ticket.deliveryTicketId, signal),
    ...DETAIL_QUERY,
  });
  const history = useQuery({
    queryKey: ["publish-release-history", scope, ticket.orderItem.orderItemId],
    queryFn: ({ signal }) => api.history(ticket.orderItem.orderItemId, signal),
    ...DETAIL_QUERY,
  });
  if (query.isError)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <p>正在读取发布清单…</p>;
  return (
    <div className="lyx-production-sections">
      <PublishEditor
        key={ticket.deliveryTicketId}
        initial={query.data}
        api={api}
        detailApi={detailApi}
        storeId={ticket.store.storeId}
        ticketId={ticket.deliveryTicketId}
        onSaved={(value) =>
          services.queryClient.setQueryData(["publish-list", scope, ticket.deliveryTicketId], value)
        }
      />
      {history.isError ? (
        <ErrorState message={history.error.message} onRetry={() => void history.refetch()} />
      ) : history.data ? (
        <PackPanel
          key={`${ticket.deliveryTicketId}:${query.data.lockVersion}`}
          api={api}
          releases={history.data.releases}
        />
      ) : (
        <p>正在读取交付版本…</p>
      )}
    </div>
  );
}
function PublishEditor({
  initial,
  api,
  detailApi,
  storeId,
  ticketId,
  onSaved,
}: {
  initial: PublishList;
  api: PublishApi;
  detailApi: DetailApi;
  storeId: string;
  ticketId: string;
  onSaved(value: PublishList): void;
}) {
  const [view, setView] = useState(initial),
    [body, setBody] = useState(() => publishInput(initial));
  const [operation, setOperation] = useState<"replace" | "import">();
  const [format, setFormat] = useState<"csv" | "tsv">("csv"),
    [content, setContent] = useState("");
  const [checked, setChecked] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [notice, setNotice] = useState<string>(),
    [uploading, setUploading] = useState(false);
  const lifetime = useRef<AbortController | null>(null),
    refreshBusy = useRef(false);
  useEffect(() => {
    const own = new AbortController();
    lifetime.current = own;
    return () => own.abort();
  }, []);
  const write = usePublishWrite(),
    canEdit = useCan("publish.list.edit");
  const locked =
    write.pending ||
    ["unknown", "accepted", "blocked"].includes(write.phase) ||
    refreshing ||
    uploading;
  const editable = canEdit && view.isEditable;
  const patch = (next: Partial<PublishReplace>) => {
    setBody((old) => ({ ...old, ...next }));
    setChecked(false);
    setNotice(undefined);
  };
  const row = (index: number, next: Partial<PublishReplace["episodes"][number]>) =>
    patch({
      episodes: body.episodes.map((item, i) => (i === index ? { ...item, ...next } : item)),
    });
  const refresh = async () => {
    if (refreshBusy.current || write.pending) return;
    refreshBusy.current = true;
    setRefreshing(true);
    setNotice(undefined);
    try {
      const signal = lifetime.current!.signal,
        fresh = await api.get(ticketId, signal);
      if (signal.aborted) return;
      setView(fresh);
      setBody((old) => ({ ...old, lockVersion: fresh.lockVersion }));
      setChecked(false);
      write.clear();
      setOperation(undefined);
      onSaved(fresh);
      setNotice("已刷新当前版本，输入已保留。请重新核对并勾选确认。");
    } catch (e) {
      if (!lifetime.current?.signal.aborted) setNotice(publishError(e));
    } finally {
      if (!lifetime.current?.signal.aborted) {
        refreshBusy.current = false;
        setRefreshing(false);
      }
    }
  };
  const save = async (kind: "replace" | "import") => {
    if (!checked || !editable || write.pending || write.phase === "blocked") return;
    if (write.phase !== "idle" && operation !== kind) return;
    setOperation(kind);
    const value = kind === "replace" ? body : { lockVersion: body.lockVersion, format, content };
    const done = await write.run(
      { ticketId, kind, value },
      async (key, signal) => {
        if (kind === "replace") await api.replace(ticketId, body, key, signal);
        else
          await api.import(
            ticketId,
            { lockVersion: body.lockVersion, format, content },
            key,
            signal,
          );
      },
      (signal) => api.get(ticketId, signal),
    );
    if (done) {
      setView(done.value);
      setBody(publishInput(done.value));
      setChecked(false);
      setOperation(undefined);
      setNotice("发布清单已保存，并已读取最新结果");
      onSaved(done.value);
    }
  };
  const missing = {
    collection_name: "合集名称",
    cover: "封面",
    intro: "简介",
    topics: "话题",
    episode_titles: "逐集标题",
  };
  return (
    <section className="lyx-production-form" aria-label="发布清单">
      <h3>发布清单</h3>
      <Alert
        type={view.completeness.isComplete ? "success" : "warning"}
        title={
          view.completeness.isComplete
            ? "服务端检查：发布清单完整"
            : `待补充：${view.completeness.missing.map((key) => missing[key]).join("、")}`
        }
        description={
          view.completeness.untitledEpisodeNos.length
            ? `未完成标题：第 ${view.completeness.untitledEpisodeNos.join("、")} 集`
            : undefined
        }
      />
      <p>
        {view.isAiDeclarationRequired ? "发布时须保留 AI 内容声明" : "当前清单无需 AI 内容声明"} ·{" "}
        {view.savedBy?.name ?? "尚未保存"}
      </p>
      {!editable ? (
        <Alert
          type="info"
          title={
            !canEdit
              ? "当前权限仅可查看发布清单"
              : view.lockReason
                ? lockReason[view.lockReason]
                : "清单暂不可编辑"
          }
        />
      ) : null}
      <fieldset disabled={!editable || locked} className="lyx-production-form">
        <FormField label="合集名称">
          {(f) => (
            <Input
              {...f}
              value={body.collectionName ?? ""}
              maxLength={60}
              onChange={(e) => patch({ collectionName: nullableText(e.target.value) })}
            />
          )}
        </FormField>
        <div>
          <p>清单封面：{body.coverFileId ? "已设置" : "尚未设置"}</p>
          {view.cover?.url && body.coverFileId === view.cover.fileId ? (
            <img src={view.cover.url} alt="清单封面" width={80} />
          ) : null}
          {editable ? (
            <>
              <Cover
                api={detailApi}
                storeId={storeId}
                disabled={locked}
                onChange={(coverFileId) => patch({ coverFileId })}
                onBusy={setUploading}
              />
              <Button
                disabled={locked || !body.coverFileId}
                onClick={() => patch({ coverFileId: null })}
              >
                移除封面
              </Button>
            </>
          ) : null}
        </div>
        <FormField label="标题模板">
          {(f) => (
            <Input
              {...f}
              value={body.titleTemplate ?? ""}
              maxLength={100}
              placeholder="支持 {剧名}、{集数}、{看点}"
              onChange={(e) => patch({ titleTemplate: nullableText(e.target.value) })}
            />
          )}
        </FormField>
        <FormField label="通用话题">
          {(f) => (
            <Select
              {...f}
              mode="tags"
              tokenSeparators={[",", "，"]}
              value={body.topics}
              disabled={!editable || locked}
              onChange={(topics: string[]) => patch({ topics })}
            />
          )}
        </FormField>
        <FormField label="通用简介">
          {(f) => (
            <Input.TextArea
              {...f}
              value={body.intro ?? ""}
              maxLength={200}
              onChange={(e) => patch({ intro: nullableText(e.target.value) })}
            />
          )}
        </FormField>
        {body.episodes.map((episode, index) => (
          <section className="lyx-production-card" key={episode.episodeNo}>
            <h4>
              第 {episode.episodeNo} 集
              {view.episodes[index]?.changedInReleaseNo
                ? ` · 第 ${view.episodes[index]?.changedInReleaseNo} 版更新`
                : ""}
            </h4>
            <FormField label={`第 ${episode.episodeNo} 集看点`}>
              {(f) => (
                <Input
                  {...f}
                  value={episode.highlight ?? ""}
                  maxLength={30}
                  onChange={(e) => row(index, { highlight: nullableText(e.target.value) })}
                />
              )}
            </FormField>
            <FormField label={`第 ${episode.episodeNo} 集标题`}>
              {(f) => (
                <Input
                  {...f}
                  value={episode.title ?? ""}
                  maxLength={100}
                  placeholder="留空使用标题模板"
                  onChange={(e) => row(index, { title: nullableText(e.target.value) })}
                />
              )}
            </FormField>
            <p>上次保存后的标题：{view.episodes[index]?.renderedTitle || "尚未生成"}</p>
            <Checkbox
              checked={episode.topics === null}
              onChange={(e) => row(index, { topics: e.target.checked ? null : [] })}
            >
              第 {episode.episodeNo} 集继承通用话题
            </Checkbox>
            {episode.topics !== null ? (
              <FormField label={`第 ${episode.episodeNo} 集话题`}>
                {(f) => (
                  <Select
                    {...f}
                    mode="tags"
                    tokenSeparators={[",", "，"]}
                    value={episode.topics}
                    disabled={!editable || locked}
                    onChange={(topics: string[]) => row(index, { topics })}
                  />
                )}
              </FormField>
            ) : null}
            <Checkbox
              checked={episode.intro === null}
              onChange={(e) => row(index, { intro: e.target.checked ? null : "" })}
            >
              第 {episode.episodeNo} 集继承通用简介
            </Checkbox>
            {episode.intro !== null ? (
              <FormField label={`第 ${episode.episodeNo} 集简介`}>
                {(f) => (
                  <Input.TextArea
                    {...f}
                    value={episode.intro ?? ""}
                    maxLength={200}
                    onChange={(e) => row(index, { intro: e.target.value })}
                  />
                )}
              </FormField>
            ) : null}
          </section>
        ))}
        <h3>导入逐集清单</h3>
        <p>
          粘贴 CSV 或 TSV，最大 200
          KiB。表头须包含“集号”，并至少包含“看点、标题、话题、简介”中的一列；逐行校验失败时不会保存任何行。
        </p>
        <FormField label="导入格式">
          {(f) => (
            <Select
              {...f}
              disabled={!editable || locked}
              value={format}
              onChange={(next) => {
                setFormat(next);
                setChecked(false);
              }}
              options={[
                { value: "csv", label: "CSV" },
                { value: "tsv", label: "TSV" },
              ]}
            />
          )}
        </FormField>
        <FormField label="表格内容">
          {(f) => (
            <Input.TextArea
              {...f}
              value={content}
              rows={5}
              onChange={(e) => {
                setContent(e.target.value);
                setChecked(false);
              }}
            />
          )}
        </FormField>
      </fieldset>
      {notice ? <Alert type="info" title={notice} /> : null}
      {write.error ? (
        <Alert
          type="error"
          title="清单未完成保存确认"
          description={
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {publishError(write.error)}
            </pre>
          }
        />
      ) : null}
      {write.phase === "blocked" ? (
        <Button loading={refreshing} onClick={() => void refresh()}>
          刷新版本并保留输入
        </Button>
      ) : null}
      {editable ? (
        <>
          <Checkbox
            checked={checked}
            disabled={locked}
            onChange={(e) => setChecked(e.target.checked)}
          >
            我已核对完整清单及本次修改
          </Checkbox>
          <div className="lyx-production-actions">
            <Button
              type="primary"
              loading={write.pending}
              disabled={
                !checked ||
                write.phase === "blocked" ||
                (write.phase !== "idle" && operation !== "replace") ||
                refreshing ||
                uploading
              }
              onClick={() => void save("replace")}
            >
              {write.phase === "accepted" ? "重试读取保存结果" : "保存发布清单"}
            </Button>
            <Button
              loading={write.pending}
              disabled={
                !checked ||
                !content ||
                new TextEncoder().encode(content).byteLength > 200 * 1024 ||
                write.phase === "blocked" ||
                (write.phase !== "idle" && operation !== "import") ||
                refreshing ||
                uploading
              }
              onClick={() => void save("import")}
            >
              {write.phase === "accepted" && operation === "import"
                ? "重试读取导入结果"
                : "导入逐集清单"}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
