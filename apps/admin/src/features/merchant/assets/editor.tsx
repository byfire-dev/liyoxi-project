import {
  STORE_ASSET_TYPE,
  STORE_ASSET_USABILITY,
  STORE_ASSET_INSIGHT_KIND,
} from "@liyoxi/contract";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Input, Modal, Select } from "antd";
import { useState } from "react";
import type { AppServices } from "../../../app/services";
import { FormField } from "../../../components/FormField";
import type { AccessSnapshot } from "../../../lib/permissions";
import { DICT_QUERY } from "../../../lib/query";
import { formError, merchantScope, status, text } from "../detail/model";
import { AssetConfirm } from "./confirm";
import { ASSET_READ_KEY, insightLabels, typeLabels } from "./model";
import { StoredFiles, newUploadSlot, uploadAssetType } from "./upload";
import type { AssetWriteApi } from "./write-api";
import {
  assetActionLabels,
  assetDraft,
  prepareAsset,
  tagOptions,
  type AssetIntent,
  type AssetPrepared,
} from "./write-model";

export function AssetEditor({
  intent,
  services,
  api,
  access,
  close,
  refresh,
  notice,
}: {
  intent: AssetIntent;
  services: AppServices;
  api: AssetWriteApi;
  access: AccessSnapshot | null;
  close(): void;
  refresh(): Promise<unknown>;
  notice(value: string): void;
}) {
  const [draft, setDraft] = useState(() => assetDraft(intent)),
    [slots, setSlots] = useState(() => [newUploadSlot()]),
    [error, setError] = useState<string>(),
    [prepared, setPrepared] = useState<AssetPrepared>();
  const storeId = intent.kind === "create" ? intent.storeId : intent.row.storeId,
    vocabulary = useQuery({
      queryKey: [...ASSET_READ_KEY, merchantScope(access), storeId, "vocabulary"],
      queryFn: ({ signal }) => api.vocabulary(signal),
      ...DICT_QUERY,
      enabled: intent.kind === "review" || intent.kind === "create",
    });
  const title = assetActionLabels[intent.kind],
    row = intent.kind === "create" ? undefined : intent.row,
    echo = [
      { label: "素材", value: row ? text(row.title) : "本门店新素材" },
      { label: "门店 ID", value: storeId },
      ...(row
        ? [
            { label: "素材 ID", value: row.storeAssetId },
            { label: "所见版本", value: String(row.lockVersion) },
          ]
        : []),
      ...(intent.kind === "create" && intent.demandId
        ? [{ label: "关联需求 ID", value: intent.demandId }]
        : []),
    ];
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
          echo,
          danger: intent.kind === "delete",
          checkLabel: "我已核对当前素材、版本和操作",
          description:
            intent.kind === "portrait-auth"
              ? "补交只追加材料，仍须复核人明确确认授权。"
              : intent.kind === "reprocess"
                ? "重新识别保留已有洞察，任务结果以后续实际状态为准。"
                : intent.kind === "delete"
                  ? "仅软删除素材，保留期与真实引用由后端处理。"
                  : "以服务端锁后复核和实际返回为准。",
        }}
      />
    );
  const vocabularyReady = vocabulary.isSuccess && !vocabulary.isFetching;
  return (
    <Modal open title={title} footer={null} onCancel={close} destroyOnHidden>
      {row ? (
        <p>
          当前素材：{text(row.title)} · 所见版本 {row.lockVersion}
        </p>
      ) : (
        <p>代本门店上传，成功入库后再登记素材；文字素材直接提交正文。</p>
      )}
      {(intent.kind === "review" || intent.kind === "create") && vocabulary.isError ? (
        <Alert
          type="error"
          title="素材字典读取失败"
          description={<Button onClick={() => void vocabulary.refetch()}>重新读取标签</Button>}
        />
      ) : null}
      {intent.kind === "review" ? (
        <>
          <FormField label="素材标题（选填）">
            {(p) => (
              <Input
                {...p}
                maxLength={60}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="内容标签">
            {(p) => (
              <Select
                {...p}
                style={{ width: "100%" }}
                mode="multiple"
                maxCount={8}
                disabled={!vocabularyReady}
                value={draft.content}
                options={tagOptions(vocabulary.data ?? [], "content")}
                onChange={(content: string[]) => setDraft({ ...draft, content })}
              />
            )}
          </FormField>
          <FormField label="用途标签">
            {(p) => (
              <Select
                {...p}
                style={{ width: "100%" }}
                mode="multiple"
                maxCount={5}
                disabled={!vocabularyReady}
                value={draft.usage}
                options={tagOptions(vocabulary.data ?? [], "usage")}
                onChange={(usage: string[]) => setDraft({ ...draft, usage })}
              />
            )}
          </FormField>
          <FormField label="时效标签">
            {(p) => (
              <Select
                {...p}
                style={{ width: "100%" }}
                disabled={!vocabularyReady}
                value={draft.timeliness || undefined}
                options={tagOptions(vocabulary.data ?? [], "timeliness")}
                onChange={(timeliness: string) => setDraft({ ...draft, timeliness })}
              />
            )}
          </FormField>
          <FormField label="时效开始日期（区间选填）">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="时效结束日期（区间选填）">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            )}
          </FormField>
        </>
      ) : null}
      {intent.kind === "review" || intent.kind === "confirm-portrait-auth" ? (
        <>
          <FormField label="可用性">
            {(p) => (
              <Select
                {...p}
                style={{ width: "100%" }}
                value={draft.usability}
                options={STORE_ASSET_USABILITY.values
                  .filter(
                    (value) =>
                      intent.kind === "review" || value === "ready" || value === "reference_only",
                  )
                  .map((value) => ({ value, label: status(value, "store_asset.usability") }))}
                onChange={(usability: string) => setDraft({ ...draft, usability })}
              />
            )}
          </FormField>
          {draft.usability === "need_reshoot" ? <p>补拍前该素材不会出现在可选素材中。</p> : null}
          {draft.usability === "need_portrait_auth" ? (
            <p>授权前仅供方案参考，不用于成片；人脸提示不等于授权。</p>
          ) : null}
        </>
      ) : null}
      {intent.kind === "confirm-portrait-auth" ? (
        <>
          <p>
            已提交 {row?.portraitAuth.fileCount ?? 0} 份材料。请先核验真实材料与授权范围，再确认。
          </p>
          <FormField label="授权核验备注（选填）">
            {(p) => (
              <Input.TextArea
                {...p}
                maxLength={200}
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            )}
          </FormField>
        </>
      ) : null}
      {intent.kind === "delete" ? (
        <FormField label="删除原因（必填）">
          {(p) => (
            <Input.TextArea
              {...p}
              maxLength={200}
              value={draft.reason}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            />
          )}
        </FormField>
      ) : null}
      {intent.kind === "reprocess" ? (
        <>
          <p>选择要重新识别的步骤；不选表示由后端按素材类型决定。旧洞察不会在此清空。</p>
          {STORE_ASSET_INSIGHT_KIND.values.map((kind) => (
            <Checkbox
              key={kind}
              checked={draft.kinds.includes(kind)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  kinds: e.target.checked
                    ? [...draft.kinds, kind]
                    : draft.kinds.filter((value) => value !== kind),
                })
              }
            >
              {insightLabels[kind]}
            </Checkbox>
          ))}
        </>
      ) : null}
      {intent.kind === "create" ? (
        <>
          <FormField label="素材类型">
            {(p) => (
              <Select
                {...p}
                style={{ width: "100%" }}
                value={draft.type}
                options={STORE_ASSET_TYPE.values.map((value) => ({
                  value,
                  label: typeLabels[value],
                }))}
                onChange={(type: string) => {
                  setDraft({ ...draft, type });
                  setSlots([newUploadSlot()]);
                }}
              />
            )}
          </FormField>
          {draft.type === "text" ? (
            <FormField label="素材正文">
              {(p) => (
                <Input.TextArea
                  {...p}
                  rows={4}
                  maxLength={500}
                  value={draft.text}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                />
              )}
            </FormField>
          ) : (
            <FormField label="素材说明（选填）">
              {(p) => (
                <Input.TextArea
                  {...p}
                  maxLength={200}
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              )}
            </FormField>
          )}
          <FormField label="内容标签（选填）">
            {(p) => (
              <Select
                {...p}
                style={{ width: "100%" }}
                mode="multiple"
                maxCount={8}
                disabled={!vocabularyReady}
                value={draft.content}
                options={tagOptions(vocabulary.data ?? [], "content")}
                onChange={(content: string[]) => setDraft({ ...draft, content })}
              />
            )}
          </FormField>
          {uploadAssetType(draft.type) ? (
            <StoredFiles
              key={draft.type}
              services={services}
              storeId={storeId}
              type={uploadAssetType(draft.type)!}
              slots={slots}
              change={setSlots}
            />
          ) : null}
        </>
      ) : null}
      {intent.kind === "portrait-auth" ? (
        <StoredFiles
          services={services}
          storeId={storeId}
          type="portrait"
          slots={slots}
          change={setSlots}
        />
      ) : null}
      {error ? <Alert type="error" title={error} /> : null}
      <div className="lyx-confirm__footer">
        <Button onClick={close}>取消</Button>
        <Button
          type="primary"
          disabled={intent.kind === "review" && !vocabularyReady}
          onClick={() => {
            try {
              setPrepared(
                prepareAsset(
                  intent,
                  draft,
                  slots.map((slot) => slot.fileId),
                  vocabulary.data ?? [],
                ),
              );
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
