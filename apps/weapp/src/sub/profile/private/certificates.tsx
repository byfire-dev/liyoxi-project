import { View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Note } from "@/components/Note";
import { Checkbox } from "@/components/Checkbox";
import { Sheet } from "@/components/Sheet";
import type { Doc, DictItems } from "./api";
import { FileGrid, type MediaFile } from "./uploads";
import { TextField, useAction, Feedback } from "./ui";
import { profileContext, profileRuntime } from "./runtime";
import { useDraft } from "./draft";

const LICENSE_FIELDS = [
  { key: "name", label: "主体名称" },
  { key: "uscc", label: "统一社会信用代码" },
  { key: "principal", label: "法定代表人 / 经营者" },
  { key: "validFrom", label: "营业期限开始" },
  { key: "validTo", label: "营业期限结束（长期填 long_term）" },
  { key: "address", label: "注册地址" },
  { key: "businessScope", label: "经营范围" },
];
export function Certificate({
  title,
  doc,
  docType,
  permitType,
  permits,
  lockVersion,
  editable,
  reload,
}: {
  title: string;
  doc?: Doc;
  docType: "business_license" | "branch_license" | "industry_permit";
  permitType?: string;
  permits: DictItems;
  lockVersion: number;
  editable: boolean;
  reload(): Promise<void>;
}) {
  const action = useAction("qualification_doc", 4);
  const [edit, setEdit] = useDraft(doc, () => false, false);
  const [fields, setFields] = useDraft(doc, (): Record<string, string> => ({}), {});
  const definition = permits.find((item) => item.code === permitType)?.ext.fields;
  const definitions =
    docType !== "industry_permit"
      ? LICENSE_FIELDS
      : Array.isArray(definition)
        ? definition.flatMap((value: unknown) =>
            typeof value === "object" &&
            value !== null &&
            "key" in value &&
            "label" in value &&
            typeof value.key === "string" &&
            typeof value.label === "string"
              ? [{ key: value.key, label: value.label }]
              : [],
          )
        : [];
  const changed = async (files: MediaFile[]) => {
    const file = files[0];
    if (!file || file.fileId === doc?.fileId) return;
    const body = { fileId: file.fileId, docType, ...(permitType ? { permitType } : {}) };
    const context = profileContext();
    const value = await action.run(body, async (key) => {
      const runtime = await profileRuntime();
      if (!action.isCurrent(context)) return;
      return runtime.api.createDoc(body, key);
    });
    if (value) {
      await reload();
      setFields({});
      setEdit(true);
    }
  };
  return (
    <Card title={title}>
      <View className="profile-spaced">
        <Feedback
          action={action}
          refresh={() => {
            void reload();
          }}
        />
        <Note>未识别，请手动填写</Note>
        {doc ? (
          <>
            <View className="profile-subtitle">
              {doc.hasSubmittedFields ? "已核对填写" : "请核对并填写证照信息"} ·{" "}
              {doc.origin === "carried" ? "沿用上轮" : "本次上传"}
            </View>
            <View>{doc.holderName}</View>
            <View className="profile-subtitle">
              {doc.certNoMask} {doc.principalNameMask}
            </View>
            {doc.displayFields.map((field) => (
              <View className="profile-subtitle" key={field.key}>
                {field.label}：{field.value}
              </View>
            ))}
            <Button
              variant="outline"
              disabled={action.busy}
              onClick={() => {
                const context = profileContext();
                void action.run({ view: doc.qualificationDocId }, async () => {
                  const runtime = await profileRuntime();
                  if (!action.isCurrent(context)) return;
                  const signed = await runtime.api.docUrl(doc.qualificationDocId);
                  if (action.isCurrent(context))
                    await Taro.previewImage({ urls: [signed.url], current: signed.url });
                });
              }}
            >
              查看证照图片
            </Button>
          </>
        ) : null}
        {editable ? (
          <>
            <FileGrid
              files={[]}
              onChange={(files) => {
                void changed(files);
              }}
              category={docType === "industry_permit" ? "kyc_permit" : "kyc_license"}
              licenseKind={docType === "industry_permit" ? undefined : docType}
              single
              max={1}
              disabled={action.busy}
            />
            {doc ? (
              <>
                <Button
                  variant="outline"
                  block
                  onClick={() => {
                    setFields({});
                    setEdit(true);
                  }}
                >
                  核对并填写信息
                </Button>
                {!doc.isEffective ? (
                  <Button
                    variant="danger"
                    loading={action.busy}
                    onClick={() => {
                      const context = profileContext();
                      void action
                        .run({ remove: doc.qualificationDocId }, async (key) => {
                          const confirm = await Taro.showModal({
                            title: "移除本轮证照",
                            content: "仅从当前草稿移除，历史审核记录保留",
                          });
                          if (!confirm.confirm || !action.isCurrent(context)) return;
                          const runtime = await profileRuntime();
                          if (!action.isCurrent(context)) return;
                          return runtime.api.removeDoc(doc.qualificationDocId, key);
                        })
                        .then(async (value) => {
                          if (value && action.isCurrent(context)) await reload();
                        });
                    }}
                  >
                    从本轮移除
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </View>
      <Sheet
        className="profile-certificate-sheet"
        visible={edit && editable && Boolean(doc)}
        title={`填写${title}`}
        description="已有脱敏值不可还原；只改动本次输入的字段，其余保留"
        onClose={() => setEdit(false)}
        footer={
          <Button
            block
            loading={action.busy}
            disabled={!Object.keys(fields).length}
            onClick={() => {
              if (!doc) return;
              const context = profileContext();
              const body = { lockVersion, fields };
              void action
                .run({ id: doc.qualificationDocId, ...body }, async (key) => {
                  const { api } = await profileRuntime();
                  if (!action.isCurrent(context)) return;
                  return api.saveDoc(doc.qualificationDocId, body, key);
                })
                .then(async (value) => {
                  if (value) {
                    setEdit(false);
                    setFields({});
                    await reload();
                  }
                });
            }}
          >
            保存核对信息
          </Button>
        }
      >
        <View className="profile-options">
          <Feedback
            action={action}
            refresh={() => {
              void reload();
            }}
          />
          {definitions.length ? (
            definitions.map((field) => (
              <TextField
                key={field.key}
                label={field.label}
                value={fields[field.key] ?? ""}
                max={field.key === "uscc" ? 18 : 2000}
                hint={
                  field.key.toLowerCase().includes("valid") ? "YYYY-MM-DD，日期须准确" : undefined
                }
                onChange={(value) => setFields((old) => ({ ...old, [field.key]: value }))}
              />
            ))
          ) : (
            <Note tone="warning">此许可证字段配置不可用，请重新加载</Note>
          )}
          {docType !== "industry_permit" ? (
            <>
              <View>负责人角色</View>
              {(
                [
                  ["legal_rep", "法定代表人"],
                  ["operator", "经营者"],
                  ["branch_head", "分支负责人"],
                ] as const
              ).map(([value, label]) => (
                <Checkbox
                  key={value}
                  shape="round"
                  checked={fields.principalRole === value}
                  onChange={() => setFields((old) => ({ ...old, principalRole: value }))}
                >
                  {label}
                </Checkbox>
              ))}
              <View>证照主体类型</View>
              {(
                [
                  ["enterprise", "企业"],
                  ["individual", "个体工商户"],
                  ["branch", "分支机构"],
                ] as const
              ).map(([value, label]) => (
                <Checkbox
                  key={value}
                  shape="round"
                  checked={fields.subjectType === value}
                  onChange={() => setFields((old) => ({ ...old, subjectType: value }))}
                >
                  {label}
                </Checkbox>
              ))}
            </>
          ) : null}
        </View>
      </Sheet>
    </Card>
  );
}
