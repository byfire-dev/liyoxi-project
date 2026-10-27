import { Alert, Checkbox, DatePicker, Form, Input, InputNumber, Select } from "antd";
import { useState } from "react";
import { DiffBlock } from "../../../components/DiffBlock";
import { ReadOnlyValue } from "../../../components/ReadOnlyValue";
import { BillingDialog } from "../plans/dialog";
import { createBillingIntent } from "../plans/model";
import type { BillingParam, BillingParamsApi } from "./api";
import { OBJECT_LABELS, PARAM_LABELS, paramText, pricingChangeBody } from "./model";
type ParameterValue = BillingParam["current"]["value"];
function IntegerListField({
  label,
  value,
  change,
}: {
  label: string;
  value: unknown;
  change(v: unknown): void;
}) {
  const [text, setText] = useState(() => (Array.isArray(value) ? value.join("、") : ""));
  return (
    <Input
      aria-label={label}
      value={text}
      placeholder="如：1、3、12"
      onChange={(e) => {
        setText(e.target.value);
        change(
          e.target.value
            .split(/[,，、\s]+/)
            .filter(Boolean)
            .map(Number),
        );
      }}
    />
  );
}
function ParamValueField({
  row,
  value,
  change,
}: {
  row: BillingParam;
  value: unknown;
  change(value: unknown): void;
}) {
  if (row.schema.type === "integer")
    return (
      <InputNumber
        aria-label={PARAM_LABELS[row.key]}
        value={typeof value === "number" ? value : null}
        min={row.schema.min}
        max={row.schema.max}
        precision={0}
        onChange={change}
      />
    );
  if (row.schema.type === "integer_list")
    return <IntegerListField label={PARAM_LABELS[row.key]} value={value} change={change} />;
  const fields = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  return (
    <div className="billing-fields">
      {Object.entries(fields).map(([key, v]) => (
        <Form.Item key={key} label={OBJECT_LABELS[key] ?? key}>
          {row.key === "expiredTermRefund" ? (
            <Select
              aria-label={OBJECT_LABELS[key] ?? key}
              value={typeof v === "string" ? v : undefined}
              options={[
                { value: "addon", label: "转为加购积分" },
                { value: "forfeit", label: "不予退回" },
              ]}
              onChange={(next) => change({ ...fields, [key]: next })}
            />
          ) : (
            <>
              <InputNumber
                aria-label={`${OBJECT_LABELS[key] ?? key}扣除比例（万分比）`}
                value={typeof v === "number" ? v : null}
                min={0}
                max={10000}
                precision={0}
                disabled={v === null}
                onChange={(next) => change({ ...fields, [key]: next })}
              />
              <Checkbox
                checked={v === null}
                onChange={(e) => change({ ...fields, [key]: e.target.checked ? null : 0 })}
              >
                由客服填写、财务核定
              </Checkbox>
            </>
          )}
        </Form.Item>
      ))}
    </div>
  );
}
export function PricingChangeDialog({
  api,
  params,
  tiers,
  earliestDate,
  canParams,
  canTiers,
  onClose,
  onSaved,
}: {
  api: BillingParamsApi;
  params: BillingParam[];
  tiers: Awaited<ReturnType<BillingParamsApi["tiers"]>>;
  earliestDate: string;
  canParams: boolean;
  canTiers: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const [intent] = useState(() => createBillingIntent("billing-pricing-change")),
    [selected, setSelected] = useState<BillingParam["key"][]>([]),
    [values, setValues] = useState<Partial<Record<BillingParam["key"], unknown>>>(() =>
      Object.fromEntries(params.map((r) => [r.key, structuredClone(r.current.value)])),
    ),
    [includeTiers, setIncludeTiers] = useState(false),
    [tierValues, setTierValues] = useState<Record<string, number | undefined>>(() =>
      Object.fromEntries(
        ["S", "A", "B", "C"].map((key) => [key, tiers.items.find((t) => t.tier === key)?.points]),
      ),
    ),
    [date, setDate] = useState<string | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [note, setNote] = useState(""),
    [title, setTitle] = useState(""),
    [summary, setSummary] = useState(""),
    [summaryNoPrice, setSummaryNoPrice] = useState("");
  const modified = () => {
      intent.change();
      setConfirmed(false);
    },
    needsNotice = selected.some((key) => params.find((p) => p.key === key)?.needsNotice);
  return (
    <BillingDialog
      title="保存积分价模板与参数变更"
      intent={intent}
      onClose={onClose}
      submitText="保存变更集"
      disabled={
        !confirmed ||
        (!selected.length && !includeTiers) ||
        (needsNotice && (!date || date < earliestDate))
      }
      submit={async () => {
        const body = pricingChangeBody({
          selected: canParams ? selected : [],
          values,
          effectiveDate: date,
          ...(canTiers && includeTiers ? { tiers: tierValues } : {}),
          note,
          title,
          summary,
          summaryNoPrice,
        });
        const result = await intent.submit(body, (key, signal) => api.create(body, key, signal));
        if (result !== undefined) {
          onSaved();
          onClose();
        }
      }}
    >
      <Alert
        type="info"
        title="等级模板立即生效；计费参数按本次选择的日期生效。只保存勾选项，历史订单与快照不回算。"
      />
      {canTiers ? (
        <Checkbox
          checked={includeTiers}
          onChange={(e) => {
            setIncludeTiers(e.target.checked);
            modified();
          }}
        >
          本次修改四档积分价模板
        </Checkbox>
      ) : (
        <p>无模板价修改权限，模板保持。</p>
      )}
      {includeTiers && canTiers ? (
        <div className="billing-grid">
          {["S", "A", "B", "C"].map((tier) => (
            <Form.Item key={tier} label={`${tier}档新积分价`}>
              <InputNumber
                aria-label={`${tier}档新积分价`}
                min={100}
                max={20000}
                precision={0}
                value={tierValues[tier]}
                onChange={(v) => {
                  setTierValues({ ...tierValues, [tier]: v ?? undefined });
                  modified();
                }}
              />
              <ReadOnlyValue
                label="当前"
                value={paramText(tiers.items.find((t) => t.tier === tier)?.points ?? "未提供")}
              />
            </Form.Item>
          ))}
        </div>
      ) : null}
      {canParams ? (
        <Form.Item label="本次修改的计费参数">
          <Select
            mode="multiple"
            aria-label="本次修改的计费参数"
            value={selected}
            options={params.map((r) => ({
              value: r.key,
              label: PARAM_LABELS[r.key],
              disabled: r.pending !== null,
            }))}
            onChange={(keys: BillingParam["key"][]) => {
              setSelected(keys);
              modified();
            }}
          />
        </Form.Item>
      ) : (
        <p>无计费参数修改权限，参数保持。</p>
      )}
      {params
        .filter((r) => selected.includes(r.key))
        .map((row) => (
          <section key={row.key} className="lyx-card billing-panel">
            <h3>{PARAM_LABELS[row.key]}</h3>
            <ParamValueField
              row={row}
              value={values[row.key]}
              change={(value) => {
                setValues({ ...values, [row.key]: value });
                modified();
              }}
            />
            <DiffBlock
              ariaLabel={`${PARAM_LABELS[row.key]}前后对照`}
              before={paramText(row.current.value)}
              after={paramText(values[row.key])}
            />
            <ReadOnlyValue
              label="种子默认"
              value={paramText(row.defaultValue)}
              reason="默认值仅供核对，不会自动回写。"
            />
          </section>
        ))}
      {selected.length ? (
        <Form.Item label={`参数生效日（选填；公告键最早 ${earliestDate}）`}>
          <DatePicker
            aria-label="参数生效日"
            format="YYYY-MM-DD"
            onChange={(value) => {
              setDate(value?.format("YYYY-MM-DD") ?? null);
              modified();
            }}
          />
          <p>
            {needsNotice
              ? "含需要公告的参数，必须选择服务端最早日或之后。"
              : "留空由服务端立即生效。"}
          </p>
        </Form.Item>
      ) : null}
      <Form.Item label="变更说明（选填）">
        <Input.TextArea
          value={note}
          maxLength={200}
          showCount
          onChange={(e) => {
            setNote(e.target.value);
            modified();
          }}
        />
      </Form.Item>
      {needsNotice ? (
        <>
          <Form.Item label="公告标题（选填）">
            <Input
              value={title}
              maxLength={40}
              showCount
              onChange={(e) => {
                setTitle(e.target.value);
                modified();
              }}
            />
          </Form.Item>
          <Form.Item label="公告说明（选填）">
            <Input.TextArea
              value={summary}
              maxLength={200}
              showCount
              onChange={(e) => {
                setSummary(e.target.value);
                modified();
              }}
            />
          </Form.Item>
          <Form.Item label="不含价格的公告说明（选填）">
            <Input.TextArea
              value={summaryNoPrice}
              maxLength={200}
              showCount
              onChange={(e) => {
                setSummaryNoPrice(e.target.value);
                modified();
              }}
            />
          </Form.Item>
        </>
      ) : null}
      <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
        已核对所选变更、前后值与生效日期
      </Checkbox>
    </BillingDialog>
  );
}
export type { ParameterValue };
