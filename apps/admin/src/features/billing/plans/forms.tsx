import {
  PlanCreateBodySchema,
  PlanNameUpdateBodySchema,
  PlanRevisionCreateBodySchema,
} from "@liyoxi/contract";
import { fenToYuan, yuanToFen } from "@liyoxi/shared/format/money";
import { Checkbox, DatePicker, Form, Input, InputNumber, Select, Switch } from "antd";
import { useState } from "react";
import { ReadOnlyValue } from "../../../components/ReadOnlyValue";
import { DiffBlock } from "../../../components/DiffBlock";
import { BillingDialog } from "./dialog";
import { createBillingIntent, moneyText, pointsText } from "./model";
import type { PlanColumn, PlansApi } from "./api";
export function PlanNameDialog({
  api,
  row,
  onClose,
  onSaved,
}: {
  api: PlansApi;
  row?: PlanColumn;
  onClose(): void;
  onSaved(): void;
}) {
  const [form] = Form.useForm<{ code: string; name: string; rank: number }>(),
    [intent] = useState(() => createBillingIntent(row ? "plan-rename" : "plan-create"));
  return (
    <BillingDialog
      title={row ? "修改套餐名称" : "新建套餐版本"}
      intent={intent}
      onClose={onClose}
      submit={async () => {
        const draft = await form.validateFields();
        const body = row
          ? PlanNameUpdateBodySchema.parse({ name: draft.name, lockVersion: row.lockVersion })
          : PlanCreateBodySchema.parse(draft);
        const result = await intent.submit(body, (key, signal) =>
          row
            ? api.rename(row.planId, PlanNameUpdateBodySchema.parse(body), key, signal)
            : api.create(PlanCreateBodySchema.parse(body), key, signal),
        );
        if (result !== undefined) {
          onSaved();
          onClose();
        }
      }}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ name: row?.name ?? "" }}
        onValuesChange={() => intent.change()}
      >
        {row ? (
          <ReadOnlyValue
            label="固定版本码 / 等级 / 所见版本"
            value={`${row.code} / ${row.rank} / ${row.lockVersion}`}
          />
        ) : (
          <>
            <Form.Item name="code" label="版本码（小写字母开头）" rules={[{ required: true }]}>
              <Input maxLength={24} placeholder="如：enterprise" />
            </Form.Item>
            <Form.Item name="rank" label="套餐等级（越高权益越多）" rules={[{ required: true }]}>
              <InputNumber min={1} max={99} precision={0} />
            </Form.Item>
          </>
        )}
        <Form.Item name="name" label="套餐名称" rules={[{ required: true, whitespace: true }]}>
          <Input maxLength={20} showCount />
        </Form.Item>
        {!row ? (
          <p>先建立未上架版本，再保存首条价目并上架。不会自动建立价格。</p>
        ) : (
          <p>只修改当前名称，历史周期及付款快照保持。</p>
        )}
      </Form>
    </BillingDialog>
  );
}
interface RevisionDraft {
  fee: string;
  monthlyPoints: number;
  discountBp: number;
  productionModel: "standard" | "advanced" | "top";
  maxStores: number;
  maxMembers: number | null;
  schedulePriority: "standard" | "priority" | "rush";
  hasMonthlyReport: boolean;
  firstCyclePromo: boolean;
  title?: string;
  summary?: string;
  summaryNoPrice?: string;
  customCycles: boolean;
  cyclePrices: { months: number; price: string }[];
}
export function PlanRevisionDialog({
  api,
  row,
  cycles,
  earliestDate,
  onClose,
  onSaved,
}: {
  api: PlansApi;
  row: PlanColumn;
  cycles: number[];
  earliestDate?: string;
  onClose(): void;
  onSaved(): void;
}) {
  const current = row.current,
    [form] = Form.useForm<RevisionDraft>(),
    [intent] = useState(() => createBillingIntent("plan-revision")),
    [effectiveDate, setEffectiveDate] = useState<string | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const customCycles = Form.useWatch("customCycles", form),
    fee = Form.useWatch("fee", form),
    monthlyPoints = Form.useWatch("monthlyPoints", form);
  return (
    <BillingDialog
      title={`发布价目修订 · ${row.name}`}
      intent={intent}
      onClose={onClose}
      disabled={!confirmed || (!!current && !effectiveDate)}
      submitText="保存价目与公告"
      submit={async () => {
        const draft = await form.validateFields();
        const body = PlanRevisionCreateBodySchema.parse({
          monthlyFeeFen: yuanToFen(draft.fee),
          monthlyPoints: draft.monthlyPoints,
          discountBp: draft.discountBp,
          productionModel: draft.productionModel,
          maxStores: draft.maxStores,
          maxMembers: draft.maxMembers ?? null,
          schedulePriority: draft.schedulePriority,
          hasMonthlyReport: draft.hasMonthlyReport,
          firstCyclePromo: draft.firstCyclePromo,
          effectiveDate,
          ...(draft.customCycles
            ? {
                cyclePrices: draft.cyclePrices.map((v) => ({
                  months: v.months,
                  priceFen: yuanToFen(v.price),
                })),
              }
            : {}),
          notice: {
            ...(draft.title ? { title: draft.title } : {}),
            ...(draft.summary ? { summary: draft.summary } : {}),
            ...(draft.summaryNoPrice ? { summaryNoPrice: draft.summaryNoPrice } : {}),
          },
        });
        const result = await intent.submit(body, (key, signal) =>
          api.revision(row.planId, body, key, signal),
        );
        if (result !== undefined) {
          onSaved();
          onClose();
        }
      }}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          fee: current ? fenToYuan(current.monthlyFeeFen) : "",
          monthlyPoints: current?.monthlyPoints,
          discountBp: current?.discountBp ?? 10000,
          productionModel: current?.productionModel ?? "standard",
          maxStores: current?.maxStores ?? 1,
          maxMembers: current?.maxMembers ?? null,
          schedulePriority: current?.schedulePriority ?? "standard",
          hasMonthlyReport: current?.hasMonthlyReport ?? false,
          firstCyclePromo: current?.hasFirstCyclePromo ?? false,
          customCycles: false,
          cyclePrices: cycles.map((months) => ({
            months,
            price: current?.cyclePrices.find((v) => v.months === months)
              ? fenToYuan(current.cyclePrices.find((v) => v.months === months)!.priceFen)
              : "",
          })),
        }}
        onValuesChange={() => {
          intent.change();
          setConfirmed(false);
        }}
      >
        <ReadOnlyValue
          label="本次来源修订"
          value={current ? `第${current.revisionNo}版 · ${current.effectiveAt}` : "首次发布"}
          reason="新增不可变修订，不改当前或历史价目。"
        />
        <DiffBlock
          ariaLabel="月费和积分前后对照"
          before={`${moneyText(current?.monthlyFeeFen)} / ${pointsText(current?.monthlyPoints)}`}
          after={`${fee || "未填写"} 元 / ${monthlyPoints ?? "未填写"} 积分`}
        />
        <div className="billing-grid">
          <Form.Item name="fee" label="月费（元）" rules={[{ required: true }]}>
            <Input inputMode="decimal" />
          </Form.Item>
          <Form.Item name="monthlyPoints" label="每月积分" rules={[{ required: true }]}>
            <InputNumber min={1} precision={0} />
          </Form.Item>
        </div>
        <div className="billing-grid">
          <Form.Item
            name="discountBp"
            label="订购折扣（万分比，10000为原价）"
            rules={[{ required: true }]}
          >
            <InputNumber min={5000} max={10000} step={100} precision={0} />
          </Form.Item>
          <Form.Item name="productionModel" label="制作模型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "standard", label: "标准" },
                { value: "advanced", label: "进阶" },
                { value: "top", label: "顶配" },
              ]}
            />
          </Form.Item>
        </div>
        <div className="billing-grid">
          <Form.Item name="maxStores" label="门店上限" rules={[{ required: true }]}>
            <InputNumber min={1} precision={0} />
          </Form.Item>
          <Form.Item name="maxMembers" label="成员上限（留空为不限）">
            <InputNumber min={1} precision={0} />
          </Form.Item>
        </div>
        <Form.Item name="schedulePriority" label="排期优先级">
          <Select
            options={[
              { value: "standard", label: "标准" },
              { value: "priority", label: "优先" },
              { value: "rush", label: "加急" },
            ]}
          />
        </Form.Item>
        <Form.Item name="hasMonthlyReport" label="月度报告" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="firstCyclePromo" label="首期沿用上一价目优惠" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="customCycles" label="手填各周期价格" valuePropName="checked">
          <Switch />
        </Form.Item>
        {customCycles ? (
          <Form.List name="cyclePrices">
            {(fields) =>
              fields.map((field) => (
                <Form.Item
                  key={field.key}
                  name={[field.name, "price"]}
                  label={`${cycles[field.name]}个月总价（元）`}
                  rules={[{ required: true }]}
                >
                  <Input inputMode="decimal" />
                </Form.Item>
              ))
            }
          </Form.List>
        ) : (
          <p>各周期价省略，由服务端按正式价目规则建立；页面不推算总价。</p>
        )}
        <Form.Item
          label={`生效日（北京时间）${earliestDate ? `；服务端最早日 ${earliestDate}` : ""}`}
          required={!!current}
        >
          <DatePicker
            aria-label="价目生效日"
            format="YYYY-MM-DD"
            onChange={(value) => {
              setEffectiveDate(value?.format("YYYY-MM-DD") ?? null);
              intent.change();
              setConfirmed(false);
            }}
          />
        </Form.Item>
        {!current ? <p>首次价目可留空立即生效；后续修订须完整公告期。</p> : null}
        <Form.Item name="title" label="公告标题（选填，空则服务端生成）">
          <Input maxLength={40} showCount />
        </Form.Item>
        <Form.Item name="summary" label="公告说明（选填）">
          <Input.TextArea maxLength={200} showCount />
        </Form.Item>
        <Form.Item name="summaryNoPrice" label="不含价格的公告说明（选填）">
          <Input.TextArea maxLength={200} showCount />
        </Form.Item>
        <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
          已核对价格、权益与生效时间
        </Checkbox>
      </Form>
    </BillingDialog>
  );
}
