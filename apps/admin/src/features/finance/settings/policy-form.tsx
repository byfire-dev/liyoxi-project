import { Button, Card, Checkbox, Input, InputNumber, Select, Space } from "antd";
import type { PolicyRule, PurchasePolicy } from "./types";
import { modeLabels, platformLabels, typeLabels } from "./payload";
const options = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
const channelOptions = [
  { value: "on", label: "开启" },
  { value: "off", label: "关闭" },
];
export function PolicyForm({
  value,
  onChange,
  disabled,
}: {
  value: PurchasePolicy;
  onChange: (value: PurchasePolicy) => void;
  disabled: boolean;
}) {
  const update = (index: number, next: PolicyRule) =>
    onChange({ rules: value.rules.map((rule, i) => (i === index ? next : rule)) });
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <p>规则按显示顺序求值。条件留空表示不限，结果留空表示沿用默认设置。</p>
      {value.rules.map((rule, index) => (
        <Card
          key={index}
          size="small"
          title={`规则 ${index + 1}`}
          extra={
            <Button
              disabled={disabled}
              onClick={() => onChange({ rules: value.rules.filter((_, i) => i !== index) })}
            >
              移除规则 {index + 1}
            </Button>
          }
        >
          <Space orientation="vertical" style={{ width: "100%" }}>
            <label>
              平台
              <Select
                aria-label={`规则${index + 1}平台`}
                mode="multiple"
                style={{ width: "100%" }}
                disabled={disabled}
                options={options(platformLabels)}
                value={rule.when.platforms ?? []}
                onChange={(platforms) =>
                  update(index, {
                    ...rule,
                    when: { ...rule.when, platforms: platforms.length ? platforms : undefined },
                  })
                }
              />
            </label>
            <label>
              客户端版本范围
              <Input
                disabled={disabled}
                value={rule.when.versionRange ?? ""}
                onChange={(e) =>
                  update(index, {
                    ...rule,
                    when: { ...rule.when, versionRange: e.target.value || undefined },
                  })
                }
              />
            </label>
            <label>
              商家主体编号（每行一个，留空为不限）
              <Input.TextArea
                disabled={disabled}
                value={rule.when.entityIds?.join("\n") ?? ""}
                onChange={(e) =>
                  update(index, {
                    ...rule,
                    when: {
                      ...rule.when,
                      entityIds: e.target.value ? e.target.value.split("\n") : undefined,
                    },
                  })
                }
              />
            </label>
            <label>
              付款类型
              <Select
                aria-label={`规则${index + 1}付款类型`}
                mode="multiple"
                style={{ width: "100%" }}
                disabled={disabled}
                options={options(typeLabels)}
                value={rule.when.types ?? []}
                onChange={(types) =>
                  update(index, {
                    ...rule,
                    when: { ...rule.when, types: types.length ? types : undefined },
                  })
                }
              />
            </label>
            <Space wrap>
              <label>
                金额下限（分，含）
                <InputNumber
                  min={0}
                  precision={0}
                  disabled={disabled}
                  value={rule.when.amountGteFen}
                  onChange={(n) =>
                    update(index, { ...rule, when: { ...rule.when, amountGteFen: n ?? undefined } })
                  }
                />
              </label>
              <label>
                金额上限（分，不含）
                <InputNumber
                  min={0}
                  precision={0}
                  disabled={disabled}
                  value={rule.when.amountLtFen}
                  onChange={(n) =>
                    update(index, { ...rule, when: { ...rule.when, amountLtFen: n ?? undefined } })
                  }
                />
              </label>
            </Space>
            <label>
              入口模式
              <Select
                aria-label={`规则${index + 1}入口模式`}
                allowClear
                style={{ width: "100%" }}
                disabled={disabled}
                options={options(modeLabels)}
                value={rule.then.mode}
                onChange={(mode) => update(index, { ...rule, then: { ...rule.then, mode } })}
              />
            </label>
            <label>
              微信支付
              <Select
                aria-label={`规则${index + 1}微信支付`}
                allowClear
                style={{ width: "100%" }}
                disabled={disabled}
                options={channelOptions}
                value={rule.then.channels?.wechat_jsapi}
                onChange={(wechat_jsapi) =>
                  update(index, {
                    ...rule,
                    then: { ...rule.then, channels: { ...rule.then.channels, wechat_jsapi } },
                  })
                }
              />
            </label>
            <label>
              对公转账
              <Select
                aria-label={`规则${index + 1}对公转账`}
                allowClear
                style={{ width: "100%" }}
                disabled={disabled}
                options={channelOptions}
                value={rule.then.channels?.bank_transfer}
                onChange={(bank_transfer) =>
                  update(index, {
                    ...rule,
                    then: { ...rule.then, channels: { ...rule.then.channels, bank_transfer } },
                  })
                }
              />
            </label>
            <Checkbox
              disabled={disabled}
              checked={!!rule.then.copySet}
              onChange={(e) =>
                update(index, {
                  ...rule,
                  then: {
                    ...rule.then,
                    copySet: e.target.checked
                      ? { planNounKey: "", pointsNounKey: "", payButtonKey: "" }
                      : undefined,
                  },
                })
              }
            >
              自定义购买文案配置
            </Checkbox>
            {rule.then.copySet
              ? (
                  [
                    ["planNounKey", "套餐名称文案"],
                    ["pointsNounKey", "积分名称文案"],
                    ["payButtonKey", "付款按钮文案"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <Input
                      disabled={disabled}
                      value={rule.then.copySet![key]}
                      onChange={(e) =>
                        update(index, {
                          ...rule,
                          then: {
                            ...rule.then,
                            copySet: { ...rule.then.copySet!, [key]: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                ))
              : null}
          </Space>
        </Card>
      ))}
      <Button
        disabled={disabled || value.rules.length >= 100}
        onClick={() => onChange({ rules: [...value.rules, { when: {}, then: {} }] })}
      >
        新增购买规则
      </Button>
    </Space>
  );
}
