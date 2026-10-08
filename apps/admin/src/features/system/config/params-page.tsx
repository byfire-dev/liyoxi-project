import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, DatePicker, Input, InputNumber, Select } from "antd";
import { useState } from "react";

import { ConfigPage } from "../../../components/ConfigPage";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { FormField } from "../../../components/FormField";
import { PageHeader } from "../../../components/PageHeader";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { useCan } from "../../../lib/permissions";
import { DICT_QUERY } from "../../../lib/query";
import { configResult, errorMessage, failureFields, isConflict } from "./api";
import {
  acknowledgeParamVersions,
  CONFIG_KEY,
  paramBody,
  paramDraft,
  paramDraftValue,
  paramsSearch,
  scheduleInstant,
  valueText,
  type Calendar,
  type CalendarResult,
  type Json,
  type ParamBody,
  type ParamDraft,
  type ParamList,
} from "./model";
import { ErrorSummary, TypedParamField, UnsavedGuard } from "./private-controls";
import "./config.css";

const route = getRouteApi("/sys/params");
export function ParamsPage() {
  const { services } = useRouteContext({ from: "__root__" });
  const navigate = route.useNavigate(),
    search = paramsSearch(route.useSearch());
  const canEdit = useCan("sys.param.edit"),
    canFlags = useCan("sys.super_admin"),
    canChecklists = useCan("flow.checklist.manage");
  const [drafts, setDrafts] = useState<Record<string, ParamDraft>>({});
  const [fieldEpoch, setFieldEpoch] = useState(0);
  const [mode, setMode] = useState<"now" | "later">("now"),
    [date, setDate] = useState(""),
    [hm, setHm] = useState("09:00"),
    [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [invalidJson, setInvalidJson] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>(),
    [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<ParamBody>();
  const [withdraw, setWithdraw] = useState<{ id: string; label: string; at: string }>();
  const [importing, setImporting] = useState(false),
    [importResult, setImportResult] = useState<CalendarResult>();
  const params = useQuery({
    queryKey: [...CONFIG_KEY, "params"],
    queryFn: async () =>
      (await configResult(
        await services.api.client.GET("/api/v1/admin/param-values"),
      )) as unknown as ParamList,
    ...DICT_QUERY,
  });
  const calendar = useQuery({
    queryKey: [...CONFIG_KEY, "calendar", search.year],
    queryFn: async () =>
      (await configResult(
        await services.api.client.GET("/api/v1/admin/calendar-days", {
          params: { query: { year: search.year, includeAllDays: "false" } },
        }),
      )) as unknown as Calendar,
    ...DICT_QUERY,
  });
  const selectedGroup =
    params.data?.groups.find((group) => group.group === search.group) ?? params.data?.groups[0];
  const items = params.data?.items.filter((item) => item.group === selectedGroup?.group) ?? [];
  const dirty = Object.keys(drafts).length > 0 || Object.keys(invalidJson).length > 0;
  const change = (key: string, value: Json) => {
    const item = params.data?.items.find((row) => row.key === key);
    if (!item) return;
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? paramDraft(item)), value } }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };
  return (
    <>
      <UnsavedGuard dirty={dirty} />
      <PageHeader
        title="参数配置"
        subtitle="当前值与预约值分开管理；工作时刻与日期均按北京时间。"
        extra={
          <div className="lyx-config-actions">
            {canFlags ? (
              <Link className="lyx-link" to="/sys/flags">
                开关管理
              </Link>
            ) : null}
            {canChecklists ? (
              <Link className="lyx-link" to="/sys/checklists">
                清单模板管理
              </Link>
            ) : null}
          </div>
        }
      />
      {notice ? <Alert type={conflict ? "warning" : "success"} title={notice} /> : null}
      {conflict ? (
        <div className="lyx-config-actions">
          <Button
            onClick={() => {
              setDrafts(acknowledgeParamVersions(drafts, params.data?.items ?? []));
              setConflict(false);
              setNotice("已核对最新版本。原草稿保留，请再次保存确认。");
            }}
          >
            我已核对最新版本，保留草稿继续
          </Button>
        </div>
      ) : null}
      <FormField label="参数分组">
        {(props) => (
          <Select
            {...props}
            aria-label="参数分组"
            value={selectedGroup?.group}
            options={params.data?.groups.map((group) => ({
              value: group.group,
              label: group.title,
            }))}
            onChange={(group: string) =>
              void navigate({ search: { ...search, group }, ignoreBlocker: true })
            }
          />
        )}
      </FormField>
      {params.isError ? (
        <ErrorState message={errorMessage(params.error)} onRetry={() => void params.refetch()} />
      ) : params.isPending ? (
        <p aria-busy="true">正在读取参数…</p>
      ) : (
        <ConfigPage
          label="参数配置"
          readOnly={!canEdit}
          pending={Boolean(confirm)}
          canSubmit={dirty && !conflict && !Object.keys(invalidJson).length}
          submitLabel={mode === "later" ? "预约参数生效" : "保存当前参数"}
          onSubmit={() => {
            try {
              const effectiveAt = mode === "later" ? scheduleInstant(date, hm) : undefined;
              if (effectiveAt && new Date(effectiveAt) <= new Date()) {
                setErrors({ effectiveAt: "预约时间必须晚于现在" });
                return;
              }
              const result = paramBody(params.data.items, drafts, effectiveAt, reason);
              setErrors(result.errors);
              if (result.body) setConfirm(result.body);
            } catch (error) {
              setErrors({ effectiveAt: errorMessage(error) });
            }
          }}
          aside={
            <>
              <h2>保存说明</h2>
              <p>
                每个参数携带读取时的最新版本。版本冲突会保留本页草稿并重新读取，核对后才能重提。
              </p>
              <p>立即保存不会撤销已有预约；撤销须使用对应预约记录的按钮。</p>
              <p>创建时快照的参数不会回改已有业务记录。</p>
              <p>
                最近保存：
                {params.data.lastSaved
                  ? `${params.data.lastSaved.staff.name} · ${appDateTimeFormat.dateTime(params.data.lastSaved.at)}`
                  : "尚无保存记录"}
              </p>
            </>
          }
        >
          {!items.length ? (
            <EmptyState title="暂无参数" />
          ) : (
            <div className="lyx-config-grid">
              {items.map((item) => (
                <section className="lyx-config-param" key={item.key} data-param-key={item.key}>
                  <TypedParamField
                    key={`${fieldEpoch}:${item.key}:${item.latestRev ?? "default"}`}
                    item={item}
                    value={paramDraftValue(item, drafts)}
                    onChange={(value) => change(item.key, value)}
                    error={errors[item.key]}
                    onJsonIssue={(issue) =>
                      setInvalidJson((prev) => {
                        const next = { ...prev };
                        if (issue) next[item.key] = issue;
                        else delete next[item.key];
                        return next;
                      })
                    }
                  />
                  <p className="lyx-config-help">
                    {item.description} ·{" "}
                    {item.snapshotOn === "create" ? "创建时快照" : "读取时生效"}
                  </p>
                  {item.defaultValue === null && (item.type === "int" || item.type === "bp") ? (
                    <p className="lyx-config-help">清空表示不设。</p>
                  ) : null}
                  <p>
                    当前：{valueText(item.value)} ·{" "}
                    {item.rev === null ? "内置默认" : `版本 ${item.rev}`}
                  </p>
                  <p className="lyx-config-help">
                    最新保存版本：{item.latestRev ?? "无"}
                    {item.savedBy ? ` · ${item.savedBy.name}` : ""}
                    {item.effectiveAt
                      ? ` · ${appDateTimeFormat.dateTime(item.effectiveAt)} 生效`
                      : ""}
                  </p>
                  {item.pending.map((pending) => (
                    <div className="lyx-config-pending" key={pending.paramValueId}>
                      <strong>预约版本 {pending.rev}</strong>
                      <p>{valueText(pending.value)}</p>
                      <p>{appDateTimeFormat.dateTime(pending.effectiveAt)} 生效</p>
                      {canEdit && pending.canWithdraw ? (
                        <Button
                          size="small"
                          onClick={() =>
                            setWithdraw({
                              id: pending.paramValueId,
                              label: item.label,
                              at: pending.effectiveAt,
                            })
                          }
                        >
                          撤销此预约
                        </Button>
                      ) : (
                        <p className="lyx-config-help">
                          {pending.canWithdraw ? "只读预约" : "临近生效，当前不可撤销"}
                        </p>
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
          {canEdit ? (
            <>
              <div className="lyx-config-actions">
                <Select
                  aria-label="保存方式"
                  value={mode}
                  options={[
                    { value: "now", label: "立即保存" },
                    { value: "later", label: "预约生效" },
                  ]}
                  onChange={(next: "now" | "later") => setMode(next)}
                />
                <Button
                  disabled={!dirty}
                  onClick={() => {
                    setDrafts({});
                    setFieldEpoch((previous) => previous + 1);
                    setInvalidJson({});
                    setConflict(false);
                    setErrors({});
                  }}
                >
                  放弃本页更改
                </Button>
                <span>已修改 {Object.keys(drafts).length} 项</span>
              </div>
              {mode === "later" ? (
                <div className="lyx-config-grid">
                  <FormField label="生效日期（北京时间）" error={errors.effectiveAt}>
                    {(props) => (
                      <DatePicker
                        {...props}
                        aria-label="生效日期（北京时间）"
                        format="YYYY-MM-DD"
                        onChange={(_value, dateString) =>
                          setDate(typeof dateString === "string" ? dateString : "")
                        }
                      />
                    )}
                  </FormField>
                  <FormField label="生效时刻（北京时间）">
                    {(props) => (
                      <Input
                        {...props}
                        type="time"
                        value={hm}
                        onChange={(event) => setHm(event.target.value)}
                      />
                    )}
                  </FormField>
                </div>
              ) : null}
              <FormField label="保存说明" error={errors.reason}>
                {(props) => (
                  <Input
                    {...props}
                    value={reason}
                    maxLength={100}
                    onChange={(event) => setReason(event.target.value)}
                  />
                )}
              </FormField>
            </>
          ) : null}
          <ErrorSummary errors={{ ...errors, ...invalidJson }} />
        </ConfigPage>
      )}
      <section className="lyx-card lyx-config-calendar" aria-label="年度工作日历">
        <h2 className="lyx-section-title">年度工作日历</h2>
        <div className="lyx-config-actions">
          <FormField label="日历年份">
            {(props) => (
              <InputNumber
                {...props}
                precision={0}
                min={2024}
                max={2100}
                value={search.year}
                onChange={(year) => {
                  if (year && year >= 2024 && year <= 2100) {
                    setImportResult(undefined);
                    void navigate({ search: { ...search, year }, ignoreBlocker: true });
                  }
                }}
              />
            )}
          </FormField>
          {canEdit ? <Button onClick={() => setImporting(true)}>导入内置年度安排</Button> : null}
        </div>
        {calendar.isError ? (
          <ErrorState
            message={errorMessage(calendar.error)}
            onRetry={() => void calendar.refetch()}
          />
        ) : calendar.isPending ? (
          <p aria-busy="true">正在读取日历…</p>
        ) : (
          <>
            <p>
              {calendar.data.importedAt
                ? `${search.year} 年已导入 · 批次 ${calendar.data.calendarVersion} · ${appDateTimeFormat.dateTime(calendar.data.importedAt)}`
                : `${search.year} 年尚未导入安排`}
            </p>
            <p>
              工作时段 {calendar.data.workHours.start}–{calendar.data.workHours.end}（北京时间）
            </p>
            {calendar.data.holidays.length ? (
              <table aria-label="年度节假日安排">
                <thead>
                  <tr>
                    <th>安排</th>
                    <th>日期</th>
                    <th>类型</th>
                    <th>天数</th>
                  </tr>
                </thead>
                <tbody>
                  {calendar.data.holidays.map((row, index) => (
                    <tr key={index}>
                      <td>{row.name}</td>
                      <td>
                        {row.from}–{row.to}
                      </td>
                      <td>{row.kind === "holiday" ? "放假" : "调休上班"}</td>
                      <td>{row.days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="暂无年度安排" />
            )}
          </>
        )}
        {importResult ? (
          <Alert
            type="success"
            title={`导入${importResult.isChanged ? "已更新" : "没有变化"}：批次 ${importResult.calendarVersion}，改变 ${importResult.changedDays.length} 天${importResult.changedDays.length ? `（${importResult.changedDays.join("、")}）` : ""}`}
          />
        ) : null}
      </section>
      {confirm ? (
        <ConfirmAction
          open
          action="params-save"
          spec={{
            title: mode === "later" ? "确认预约参数" : "确认保存参数",
            echo: [
              {
                label: "变更项",
                value: confirm.items
                  .map(
                    (item) =>
                      params.data?.items.find((row) => row.key === item.key)?.label ?? item.key,
                  )
                  .join("、"),
              },
              {
                label: "生效",
                value: confirm.items[0]?.effectiveAt
                  ? appDateTimeFormat.dateTime(confirm.items[0].effectiveAt)
                  : "立即保存；已有预约保持",
              },
            ],
            checkLabel: "我已核对参数内容与生效时间",
          }}
          onCancel={() => setConfirm(undefined)}
          onDone={() => {
            setConfirm(undefined);
            setDrafts({});
            setErrors({});
            setInvalidJson({});
            setNotice("参数已保存，当前与预约版本已重新读取");
          }}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              await configResult(
                await services.api.client.PUT("/api/v1/admin/param-values", {
                  body: confirm,
                  headers: { "Idempotency-Key": idempotencyKey },
                }),
              );
              await Promise.all([params.refetch(), calendar.refetch()]);
              return { outcome: "done" };
            } catch (error) {
              setErrors(failureFields(error));
              if (isConflict(error)) {
                await params.refetch();
                setConflict(true);
                setConfirm(undefined);
                setNotice("参数版本冲突：最新数据已读取，原草稿保留。请核对后重新确认。");
              }
              return { outcome: "failed", message: errorMessage(error) };
            }
          }}
        />
      ) : null}
      {withdraw ? (
        <ConfirmAction
          open
          action="param-withdraw"
          spec={{
            title: "撤销预约参数",
            echo: [
              { label: "参数", value: withdraw.label },
              { label: "生效时间", value: appDateTimeFormat.dateTime(withdraw.at) },
            ],
            checkLabel: "我确认撤销这条预约，当前生效值保持",
            danger: true,
          }}
          onCancel={() => setWithdraw(undefined)}
          onDone={() => {
            setWithdraw(undefined);
            setNotice("预约已撤销，当前值保持，版本已重新读取");
          }}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              await configResult(
                await services.api.client.POST(
                  "/api/v1/admin/param-values/{paramValueId}/withdraw",
                  {
                    params: { path: { paramValueId: withdraw.id } },
                    body: {},
                    headers: { "Idempotency-Key": idempotencyKey },
                  },
                ),
              );
              await params.refetch();
              return { outcome: "done" };
            } catch (error) {
              await params.refetch();
              return { outcome: "failed", message: errorMessage(error) };
            }
          }}
        />
      ) : null}
      {importing ? (
        <ConfirmAction
          open
          action="calendar-import"
          spec={{
            title: "导入内置年度安排",
            echo: [{ label: "年份", value: String(search.year) }],
            description:
              "由服务端读取已内置的官方安排。没有内置的年份会正式拒绝；不上传自定义日期。",
            checkLabel: "我确认导入该年度安排",
          }}
          onCancel={() => setImporting(false)}
          onDone={() => setImporting(false)}
          onConfirm={async ({ idempotencyKey }) => {
            try {
              const result = await configResult(
                await services.api.client.POST("/api/v1/admin/calendar-days/import", {
                  body: { year: search.year },
                  headers: { "Idempotency-Key": idempotencyKey },
                }),
              );
              setImportResult(result as unknown as CalendarResult);
              await calendar.refetch();
              return { outcome: "done" };
            } catch (error) {
              return { outcome: "failed", message: errorMessage(error) };
            }
          }}
        />
      ) : null}
    </>
  );
}
