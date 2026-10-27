import { PlanAdminQuoteBodySchema } from "@liyoxi/contract";
import { Alert, Button, Form, InputNumber, Select } from "antd";
import { useEffect, useState } from "react";
import { InfoList } from "../../../components/InfoList";
import { billingError, type PlanColumn, type PlansApi } from "./api";
import { createBillingRead, moneyText, pointsText } from "./model";
interface Draft {
  kind: "upgrade" | "renewal";
  planId: string;
  fromPlanId?: string;
  remainingDays?: number;
  months?: number;
}
export function PlanQuotePanel({
  api,
  plans,
  cycles,
}: {
  api: PlansApi;
  plans: PlanColumn[];
  cycles: number[];
}) {
  const [form] = Form.useForm<Draft>(),
    [reader] = useState(createBillingRead),
    [result, setResult] = useState<Awaited<ReturnType<PlansApi["quote"]>>>(),
    [error, setError] = useState<string>(),
    [pending, setPending] = useState(false);
  const kind = Form.useWatch("kind", form);
  useEffect(() => {
    reader.activate();
    return () => reader.close();
  }, [reader]);
  const invalidate = () => {
    reader.invalidate();
    setResult(undefined);
    setPending(false);
    setError(undefined);
  };
  async function quote() {
    try {
      const body = PlanAdminQuoteBodySchema.parse(await form.validateFields());
      setResult(undefined);
      setError(undefined);
      setPending(true);
      const next = await reader.run((signal) => api.quote(body, signal));
      if (next !== undefined) {
        setResult(next);
        setPending(false);
      }
    } catch (cause) {
      setError(billingError(cause));
      setPending(false);
    }
  }
  const generic = result?.scope === "generic" ? result.generic : undefined;
  return (
    <section className="lyx-card billing-panel billing-quote" aria-label="通用报价试算">
      <h2>通用报价试算</h2>
      <p>试算不生成付款单；实际主体金额以开单时服务端重新报价为准。</p>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ kind: "upgrade", remainingDays: 15, months: cycles[0] }}
        onValuesChange={invalidate}
      >
        <Form.Item name="kind" label="试算类型">
          <Select
            options={[
              { value: "upgrade", label: "升级补差" },
              { value: "renewal", label: "续费" },
            ]}
          />
        </Form.Item>
        <Form.Item name="planId" label="目标套餐" rules={[{ required: true }]}>
          <Select
            options={plans
              .filter((p) => p.isListed && p.current)
              .map((p) => ({ value: p.planId, label: p.name }))}
          />
        </Form.Item>
        {kind === "upgrade" ? (
          <>
            <Form.Item name="fromPlanId" label="当前套餐" rules={[{ required: true }]}>
              <Select
                options={plans
                  .filter((p) => p.current)
                  .map((p) => ({ value: p.planId, label: p.name }))}
              />
            </Form.Item>
            <Form.Item name="remainingDays" label="本月剩余天数" rules={[{ required: true }]}>
              <InputNumber min={1} max={30} precision={0} />
            </Form.Item>
          </>
        ) : (
          <Form.Item name="months" label="续费周期" rules={[{ required: true }]}>
            <Select options={cycles.map((m) => ({ value: m, label: `${m}个月` }))} />
          </Form.Item>
        )}
        <Button onClick={() => void quote()} loading={pending}>
          试算
        </Button>
      </Form>
      {error ? <Alert role="alert" type="error" title={error} /> : null}
      {generic ? (
        <>
          <p role="status">{generic.formulaText}</p>
          <InfoList
            items={
              "proratedFen" in generic
                ? [
                    { label: "本月差价", value: moneyText(generic.proratedFen) },
                    { label: "立即补发", value: pointsText(generic.topupPoints) },
                    { label: "每月差价", value: moneyText(generic.feeDeltaPerMonthFen) },
                    { label: "每月积分差", value: pointsText(generic.monthlyDeltaPoints) },
                    { label: "折算天数", value: `${generic.remainingDays} / ${generic.baseDays}` },
                  ]
                : [
                    { label: "周期总价", value: moneyText(generic.cyclePriceFen) },
                    { label: "每月积分", value: pointsText(generic.monthlyPoints) },
                    { label: "周期", value: `${generic.months}个月` },
                  ]
            }
          />
        </>
      ) : null}
    </section>
  );
}
