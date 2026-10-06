import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Input, Modal, Radio, Select } from "antd";
import { useState } from "react";
import { CheckList } from "../../../components/CheckList";
import { FormField } from "../../../components/FormField";
import { Can } from "../../../lib/permissions";
import { DETAIL_QUERY } from "../../../lib/query";
import type { DetailApi, EpisodeQcBody, Grid, QcBody, Template, Ticket } from "./api";
import { DETAIL_KEY, qualityProblem } from "./model";
import { useDeliveryWrite } from "./write";
export interface QualityInput {
  results: QcBody["results"];
  reason: string;
}
export const emptyQuality = (): QualityInput => ({ results: [], reason: "" });
export function QualityFields({
  template,
  value,
  onChange,
  disabled,
}: {
  template: Template;
  value: QualityInput;
  onChange(value: QualityInput): void;
  disabled: boolean;
}) {
  const update = (key: string, patch: Partial<QcBody["results"][number]>) => {
    const old = value.results.find((r) => r.key === key);
    const next = { key, result: "pass" as const, ...old, ...patch };
    onChange({ ...value, results: [...value.results.filter((r) => r.key !== key), next] });
  };
  return (
    <div className="lyx-production-form">
      <p>勾选通过项；不通过或不适用请在对应条目中选择。</p>
      <CheckList
        items={template.items}
        checked={value.results.filter((r) => r.result === "pass").map((r) => r.key)}
        readOnly={disabled}
        onChange={(checked) =>
          onChange({
            ...value,
            results: template.items.flatMap((item) => {
              const old = value.results.find((r) => r.key === item.key);
              return checked.includes(item.key)
                ? [{ key: item.key, result: "pass" as const }]
                : old && old.result !== "pass"
                  ? [old]
                  : [];
            }),
          })
        }
      />
      {template.items.map((item) => {
        const row = value.results.find((r) => r.key === item.key);
        return (
          <section key={item.key} className="lyx-production-qc-row">
            <strong>{item.label}</strong>
            <Radio.Group
              aria-label={`${item.label}其他结论`}
              value={row?.result === "pass" ? undefined : row?.result}
              disabled={disabled}
              onChange={(e) =>
                update(item.key, { result: e.target.value as "fail" | "na", note: null })
              }
              options={[
                { label: "不通过", value: "fail" },
                ...(item.allowNa ? [{ label: "不适用", value: "na" }] : []),
              ]}
            />
            {row?.result === "fail" ? (
              <FormField label={`${item.label}不通过说明`} value={row.note ?? ""} maxLength={200}>
                {(field) => (
                  <Input.TextArea
                    {...field}
                    rows={2}
                    value={row.note ?? ""}
                    maxLength={200}
                    disabled={disabled}
                    onChange={(e) => update(item.key, { note: e.target.value })}
                  />
                )}
              </FormField>
            ) : null}
          </section>
        );
      })}
      {value.results.some((r) => r.result === "fail") ? (
        <FormField label="不通过原因" value={value.reason} maxLength={200}>
          {(field) => (
            <Input.TextArea
              {...field}
              rows={2}
              value={value.reason}
              maxLength={200}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, reason: e.target.value })}
            />
          )}
        </FormField>
      ) : null}
    </div>
  );
}
function qcBody(template: Template, input: QualityInput): QcBody {
  return {
    checklistVersionNo: template.versionNo,
    results: input.results,
    ...(input.results.some((r) => r.result === "fail")
      ? { rejectReason: input.reason.trim() }
      : {}),
  };
}
export function QualityModal({
  mode,
  ticket,
  grid,
  api,
  onClose,
  onRefresh,
}: {
  mode: "sample" | "episodes" | "package";
  ticket: Ticket;
  grid?: Grid;
  api: DetailApi;
  onClose(): void;
  onRefresh(): void;
}) {
  const code = mode === "sample" ? "qc.sample" : mode === "episodes" ? "qc.episode" : "qc.package";
  const title = mode === "sample" ? "样片质检" : mode === "episodes" ? "逐集质检" : "成片包质检";
  const template = useQuery({
    queryKey: [...DETAIL_KEY, "checklist", code],
    queryFn: () => api.template(code),
    ...DETAIL_QUERY,
  });
  const outputs =
    grid?.episodes.flatMap((e) => (e.latest ? [e.latest] : e.current ? [e.current] : [])) ?? [];
  const [input, setInput] = useState(emptyQuality),
    [selected, setSelected] = useState(() => outputs.map((e) => e.episodeOutputId));
  const [exceptions, setExceptions] = useState<Record<string, QualityInput>>({});
  const write = useDeliveryWrite(() => {
    onRefresh();
    onClose();
  });
  const problem = !template.data
    ? "质检模板尚未就绪"
    : qualityProblem(template.data, input.results, input.reason) ||
      (mode === "episodes" && !selected.length ? "请选择待质检的集" : null) ||
      Object.values(exceptions)
        .map((e) => qualityProblem(template.data!, e.results, e.reason))
        .find(Boolean);
  const allowed =
    mode === "sample"
      ? ticket.currentSample?.actions.includes("inspect")
      : ticket.actions.includes(mode === "episodes" ? "inspect-episodes" : "inspect-package");
  const submit = () => {
    if (!template.data || problem) return;
    const body = qcBody(template.data, input);
    if (mode === "episodes") {
      const episodeBody: EpisodeQcBody = {
        episodeOutputIds: selected,
        checklistVersionNo: body.checklistVersionNo,
        defaultResults: body.results,
        ...(body.rejectReason ? { defaultRejectReason: body.rejectReason } : {}),
        exceptions: Object.entries(exceptions)
          .filter(([id]) => selected.includes(id))
          .map(([episodeOutputId, e]) => ({
            episodeOutputId,
            results: e.results,
            ...(e.results.some((r) => r.result === "fail")
              ? { rejectReason: e.reason.trim() }
              : {}),
          })),
      };
      void write.submit({ mode, id: ticket.deliveryTicketId, ...episodeBody }, (key) =>
        api.inspectEpisodes(ticket.deliveryTicketId, episodeBody, key),
      );
    } else {
      const id = mode === "sample" ? ticket.currentSample!.sampleId : ticket.deliveryTicketId;
      void write.submit({ mode, id, ...body }, (key) =>
        mode === "sample" ? api.inspectSample(id, body, key) : api.inspectPackage(id, body, key),
      );
    }
  };
  return (
    <Modal
      open
      title={title}
      width={640}
      styles={{ body: { maxHeight: "calc(100vh - 260px)", overflowY: "auto" } }}
      footer={
        <div className="lyx-production-footer">
          <Button disabled={write.pending} onClick={onClose}>
            取消
          </Button>
          {allowed ? (
            <Can
              module="delivery"
              need="o"
              action={mode === "sample" ? "delivery.sample.qc" : "delivery.episode.qc"}
            >
              <Button type="primary" disabled={!!problem} loading={write.pending} onClick={submit}>
                提交质检
              </Button>
            </Can>
          ) : null}
        </div>
      }
      onCancel={() => {
        if (!write.pending) onClose();
      }}
      closable={!write.pending}
      keyboard={!write.pending}
      mask={{ closable: !write.pending }}
    >
      <div className="lyx-production-form">
        <p>
          {ticket.store.storeName ?? "未命名门店"} · {ticket.dramaTitle} · 清单第{" "}
          {template.data?.versionNo ?? "—"} 版
        </p>
        {template.isError ? (
          <Alert
            type="error"
            title={template.error.message}
            action={<Button onClick={() => void template.refetch()}>重新读取</Button>}
          />
        ) : null}
        {template.isPending ? (
          <p>正在读取质检清单…</p>
        ) : !template.data && !template.isError ? (
          <Alert type="warning" title="暂无有效质检模板" />
        ) : null}
        {mode === "episodes" ? (
          <FormField label="待质检剧集">
            {(field) => (
              <Select
                {...field}
                mode="multiple"
                value={selected}
                disabled={write.pending}
                options={outputs.map((e) => ({
                  label: `第 ${e.episodeNo} 集 · 第 ${e.revisionNo} 版`,
                  value: e.episodeOutputId,
                }))}
                onChange={(ids: string[]) => {
                  setSelected(ids);
                  setExceptions((old) =>
                    Object.fromEntries(Object.entries(old).filter(([id]) => ids.includes(id))),
                  );
                }}
              />
            )}
          </FormField>
        ) : null}
        {template.data ? (
          <>
            <h3>{mode === "episodes" ? "默认质检结论" : "质检结论"}</h3>
            <QualityFields
              template={template.data}
              value={input}
              onChange={setInput}
              disabled={write.pending}
            />
            {mode === "episodes" ? (
              <>
                <FormField label="单集例外">
                  {(field) => (
                    <Select
                      {...field}
                      mode="multiple"
                      value={Object.keys(exceptions)}
                      disabled={write.pending}
                      options={outputs
                        .filter((e) => selected.includes(e.episodeOutputId))
                        .map((e) => ({ value: e.episodeOutputId, label: `第 ${e.episodeNo} 集` }))}
                      onChange={(ids: string[]) =>
                        setExceptions((old) =>
                          Object.fromEntries(ids.map((id) => [id, old[id] ?? emptyQuality()])),
                        )
                      }
                    />
                  )}
                </FormField>
                {Object.entries(exceptions).map(([id, value]) => (
                  <section className="lyx-production-card" key={id}>
                    <h3>第 {outputs.find((e) => e.episodeOutputId === id)?.episodeNo} 集例外</h3>
                    <QualityFields
                      template={template.data!}
                      value={value}
                      onChange={(next) => setExceptions({ ...exceptions, [id]: next })}
                      disabled={write.pending}
                    />
                  </section>
                ))}
              </>
            ) : null}
          </>
        ) : null}
        {write.error ? (
          <Alert
            type="error"
            title={write.error}
            action={
              <Button
                disabled={write.pending}
                onClick={() =>
                  void template.refetch().then(() => {
                    setInput(emptyQuality());
                    setExceptions({});
                    write.setError(undefined);
                  })
                }
              >
                重载清单并重新检查
              </Button>
            }
          />
        ) : null}
        {problem && template.data ? <p className="lyx-production-hint">{problem}</p> : null}
      </div>
    </Modal>
  );
}
