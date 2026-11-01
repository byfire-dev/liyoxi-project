import { useQuery } from "@tanstack/react-query";
import { Checkbox, Input, Select } from "antd";
import { FormField } from "../../../components/FormField";
import { canAction, type AccessSnapshot } from "../../../lib/permissions";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import type { M5TicketApi, M5Ticket } from "./m5-api";
import { forceTargets, type ActionFields, type TicketAction } from "./m5-actions";
import type { DetailApi } from "./api";
import { M5FeedbackUpload } from "./m5-feedback-upload";
import { actorScope } from "../../system/staff-access";

export function M5ActionFields({
  ticket,
  action,
  fields,
  setFields,
  disabled,
  api,
  access,
  uploadApi,
  onUploading,
}: {
  ticket: M5Ticket;
  action: TicketAction;
  fields: ActionFields;
  setFields(next: ActionFields): void;
  disabled: boolean;
  api: M5TicketApi;
  access: AccessSnapshot | null;
  uploadApi: DetailApi;
  onUploading(value: boolean): void;
}) {
  const patch = (value: Partial<ActionFields>) => setFields({ ...fields, ...value });
  const assignment = action === "assign-editor" || action === "assign-publisher";
  const candidates = useQuery({
    queryKey: ["delivery", "m5-candidates", actorScope(access), action],
    queryFn: ({ signal }) =>
      api.candidates(action === "assign-editor" ? "editor" : "publisher", signal),
    enabled: assignment,
  });
  const load = useQuery({
    queryKey: ["delivery", "m5-open-work", actorScope(access), fields.staffId],
    queryFn: ({ signal }) => api.openWork(fields.staffId, signal),
    enabled: assignment && !!fields.staffId && canAction(access, "sys.staff.manage"),
  });
  const reasons = useQuery({
    queryKey: ["delivery", "m5-reissue-reasons", actorScope(access)],
    queryFn: ({ signal }) => api.reasons(signal),
    enabled: action === "reissue",
  });
  const template = useQuery({
    queryKey: ["delivery", "m5-precheck", actorScope(access)],
    queryFn: ({ signal }) => api.template(signal),
    enabled: action === "publish-reissue",
  });
  const text = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    maxLength = 200,
  ) => (
    <FormField label={label} value={value} maxLength={maxLength}>
      {(props) => (
        <Input.TextArea
          {...props}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          rows={3}
          disabled={disabled}
        />
      )}
    </FormField>
  );
  return (
    <div className="lyx-production-form">
      {assignment ? (
        <>
          <FormField label={action === "assign-editor" ? "剪辑师" : "发布专员"}>
            {(props) => (
              <Select
                {...props}
                value={fields.staffId || undefined}
                onChange={(staffId) => patch({ staffId })}
                disabled={disabled || candidates.isError}
                loading={candidates.isPending}
                options={candidates.data?.items
                  .filter(
                    (row) =>
                      row.status === "active" &&
                      row.staffId !==
                        (action === "assign-editor"
                          ? ticket.editor?.staffId
                          : ticket.publisher?.staffId),
                  )
                  .map((row) => ({ value: row.staffId, label: row.name }))}
              />
            )}
          </FormField>
          {candidates.isError ? <p role="alert">候选读取失败，请关闭后重新读取</p> : null}
          {load.data ? (
            <p>
              当前在办：{load.data.total} 项
              {load.data.bySource.map((row) => ` · ${row.source} ${row.count}`).join("")}
            </p>
          ) : null}
          {(action === "assign-editor" ? ticket.editor : ticket.publisher) ? (
            <FormField label="指派原因">
              {(props) => (
                <Select
                  {...props}
                  value={fields.reasonCode}
                  disabled={disabled}
                  onChange={(reasonCode) => patch({ reasonCode })}
                  options={[
                    { value: "workload", label: "工作量调整" },
                    { value: "merchant_request", label: "商家要求" },
                    { value: "staff_change", label: "人员变动" },
                    { value: "other", label: "其他" },
                  ]}
                />
              )}
            </FormField>
          ) : null}
        </>
      ) : null}
      {action === "force-transition" ? (
        <FormField label="更正至步骤">
          {(props) => (
            <Select
              {...props}
              value={fields.toStep || undefined}
              disabled={disabled}
              onChange={(toStep) => patch({ toStep })}
              options={forceTargets(ticket.step).map((step) => ({
                value: step,
                label: statusToneByEnum("delivery_ticket.step", step)?.admin?.label ?? step,
              }))}
            />
          )}
        </FormField>
      ) : null}
      {action === "reschedule" ||
      (action === "force-transition" &&
        ticket.step === "takedown" &&
        fields.toStep === "in_service") ? (
        <FormField label={action === "reschedule" ? "新的约定上线日" : "新的使用止日"}>
          {(props) => (
            <Input
              {...props}
              type="date"
              value={fields.date}
              disabled={disabled}
              onChange={(e) => patch({ date: e.target.value })}
            />
          )}
        </FormField>
      ) : null}
      {action === "remind" ? (
        <FormField label="催办事项">
          {(props) => (
            <Select
              {...props}
              disabled={disabled}
              value={fields.scene || undefined}
              onChange={(scene) => patch({ scene })}
              options={ticket.remindScenes.map((scene) => ({
                value: scene,
                label: {
                  confirm_plan: "确认方案",
                  confirm_sample: "确认样片",
                  golive: "提交上线信息",
                }[scene],
              }))}
            />
          )}
        </FormField>
      ) : null}
      {action === "reissue" ? (
        <>
          <FormField label="补发原因">
            {(props) => (
              <Select
                {...props}
                disabled={disabled}
                value={fields.reasonCode || undefined}
                loading={reasons.isPending}
                onChange={(reasonCode) => patch({ reasonCode })}
                options={reasons.data?.items
                  .filter((row) => row.isEnabled)
                  .map((row) => ({ value: row.code, label: row.name }))}
              />
            )}
          </FormField>
          <fieldset disabled={disabled}>
            <legend>补发集数</legend>
            {Array.from({ length: ticket.episodeCount }, (_, n) => n + 1).map((episodeNo) => (
              <Checkbox
                key={episodeNo}
                checked={fields.episodes.includes(episodeNo)}
                onChange={(e) =>
                  patch({
                    episodes: e.target.checked
                      ? [...fields.episodes, episodeNo].sort((a, b) => a - b)
                      : fields.episodes.filter((n) => n !== episodeNo),
                  })
                }
              >
                第 {episodeNo} 集
              </Checkbox>
            ))}
          </fieldset>
        </>
      ) : null}
      {action === "publish-reissue" ? (
        <fieldset disabled={disabled}>
          <legend>补发交付前检查</legend>
          {template.isPending ? (
            <p>正在读取当前清单…</p>
          ) : template.isError || !template.data?.items[0] ? (
            <p role="alert">无法读取检查清单，请关闭后重新读取</p>
          ) : (
            template.data.items[0].items.map((item) => (
              <Checkbox
                key={item.key}
                checked={
                  fields.precheck?.results.some(
                    (result) => result.key === item.key && result.result === "pass",
                  ) ?? false
                }
                onChange={(e) => {
                  const t = template.data!.items[0]!;
                  patch({
                    precheck: {
                      checklistVersionNo: t.versionNo,
                      results: t.items
                        .filter((row) =>
                          row.key === item.key
                            ? e.target.checked
                            : fields.precheck?.results.some((old) => old.key === row.key),
                        )
                        .map((row) => ({ key: row.key, result: "pass" })),
                    },
                  });
                }}
              >
                {item.label}
              </Checkbox>
            ))
          )}
        </fieldset>
      ) : null}
      {action === "feedback" ? (
        <>
          <FormField label="修改类型">
            {(props) => (
              <Select
                {...props}
                disabled={disabled}
                value={fields.feedbackKind}
                onChange={(feedbackKind) => patch({ feedbackKind })}
                options={[
                  { value: "compose", label: "合成问题" },
                  { value: "ad_content", label: "广告内容" },
                ]}
              />
            )}
          </FormField>
          {fields.feedbackKind === "ad_content" ? (
            <FormField label="本样片使用的广告">
              {(props) => (
                <Select
                  {...props}
                  disabled={disabled}
                  value={fields.adId || undefined}
                  onChange={(adId) => patch({ adId })}
                  options={ticket.currentSample?.adsUsed.map((ad) => ({
                    value: ad.adId,
                    label: `${ad.adNo} · 第 ${ad.versionNo} 版`,
                  }))}
                />
              )}
            </FormField>
          ) : null}
          <FormField label="时间点（毫秒，可选）">
            {(props) => (
              <Input
                {...props}
                disabled={disabled}
                type="number"
                min={0}
                step={1}
                value={fields.feedbackTime}
                onChange={(e) => patch({ feedbackTime: e.target.value })}
              />
            )}
          </FormField>
          <M5FeedbackUpload
            api={uploadApi}
            storeId={ticket.store.storeId}
            disabled={disabled}
            onChange={(feedbackFileIds) => patch({ feedbackFileIds })}
            onBusy={onUploading}
          />
        </>
      ) : null}
      {action === "restamp" ? (
        <>
          <FormField label="AI工具名称">
            {(props) => (
              <Input
                {...props}
                disabled={disabled}
                value={fields.tools[0]?.name ?? ""}
                onChange={(e) =>
                  patch({
                    tools: [
                      {
                        name: e.target.value,
                        version: fields.tools[0]?.version ?? "",
                        usedFor: fields.tools[0]?.usedFor ?? "",
                      },
                    ],
                  })
                }
              />
            )}
          </FormField>
          <FormField label="AI工具版本">
            {(props) => (
              <Input
                {...props}
                disabled={disabled}
                value={fields.tools[0]?.version ?? ""}
                onChange={(e) =>
                  patch({
                    tools: [
                      {
                        name: fields.tools[0]?.name ?? "",
                        version: e.target.value,
                        usedFor: fields.tools[0]?.usedFor ?? "",
                      },
                    ],
                  })
                }
              />
            )}
          </FormField>
          <FormField label="AI使用用途">
            {(props) => (
              <Input
                {...props}
                disabled={disabled}
                value={fields.tools[0]?.usedFor ?? ""}
                onChange={(e) =>
                  patch({
                    tools: [
                      {
                        name: fields.tools[0]?.name ?? "",
                        version: fields.tools[0]?.version ?? "",
                        usedFor: e.target.value,
                      },
                    ],
                  })
                }
              />
            )}
          </FormField>
        </>
      ) : null}
      {!["reevaluate", "remind", "mark-sent", "recheck"].includes(action)
        ? text(
            action === "force-transition"
              ? "更正原因（至少10字）"
              : action === "feedback"
                ? "修改意见"
                : "处理说明",
            fields.note,
            (note) => patch({ note }),
          )
        : null}
    </div>
  );
}
