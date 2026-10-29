import { Card, Space } from "antd";
import { InfoList } from "../../../components/InfoList";
import { moneyText } from "../payments/model";
import type { ConfigRevision, PolicyRule } from "./types";

export const platformLabels = {
  ios: "iOS",
  android: "Android",
  harmony: "鸿蒙",
  windows: "Windows",
  mac: "Mac",
  devtools: "开发工具",
  unknown: "未知平台",
} as const;
export const typeLabels = {
  plan_new: "新购套餐",
  plan_renew: "续费套餐",
  plan_upgrade: "升级套餐",
  topup: "积分加购",
} as const;
export const modeLabels = {
  in_app: "应用内购买",
  offline_contract: "线下签约",
  hidden: "隐藏入口",
} as const;
const channel = (value?: "on" | "off") =>
  value === "on" ? "开启" : value === "off" ? "关闭" : "保持默认";
function RuleView({ rule, index }: { rule: PolicyRule; index: number }) {
  return (
    <Card size="small" title={`规则 ${index + 1}`}>
      <InfoList
        items={[
          {
            label: "平台",
            value: rule.when.platforms?.map((value) => platformLabels[value]).join("、") ?? "不限",
          },
          { label: "客户端版本", value: rule.when.versionRange ?? "不限" },
          { label: "商家主体", value: rule.when.entityIds?.join("、") ?? "不限" },
          {
            label: "付款类型",
            value: rule.when.types?.map((value) => typeLabels[value]).join("、") ?? "不限",
          },
          {
            label: "金额范围",
            value: `${rule.when.amountGteFen === undefined ? "不限" : moneyText(rule.when.amountGteFen)}（含）至 ${rule.when.amountLtFen === undefined ? "不限" : moneyText(rule.when.amountLtFen)}（不含）`,
          },
          { label: "入口模式", value: rule.then.mode ? modeLabels[rule.then.mode] : "保持默认" },
          {
            label: "支付渠道",
            value: `微信：${channel(rule.then.channels?.wechat_jsapi)}；对公：${channel(rule.then.channels?.bank_transfer)}`,
          },
          {
            label: "文案配置",
            value: rule.then.copySet
              ? `套餐：${rule.then.copySet.planNounKey}；积分：${rule.then.copySet.pointsNounKey}；按钮：${rule.then.copySet.payButtonKey}`
              : "保持默认",
          },
        ]}
      />
    </Card>
  );
}
export function ConfigPayload({ value }: { value: ConfigRevision | null }) {
  if (!value) return <p>尚无生效版本</p>;
  const payload = value.payload;
  if ("accountNoMask" in payload)
    return (
      <InfoList
        items={[
          { label: "户名", value: payload.accountName },
          { label: "开户行", value: payload.bankName },
          { label: "账号", value: payload.accountNoMask },
        ]}
      />
    );
  if ("rules" in payload)
    return payload.rules.length ? (
      <Space orientation="vertical" style={{ width: "100%" }}>
        {payload.rules.map((rule, index) => (
          <RuleView key={index} rule={rule} index={index} />
        ))}
      </Space>
    ) : (
      <p>没有附加规则，沿用默认购买策略</p>
    );
  return (
    <InfoList
      items={[
        { label: "后台代开单", value: payload.adminCreateOrder ? "开启" : "关闭" },
        { label: "微信单笔限额", value: moneyText(payload.wechatSingleLimitFen) },
        { label: "微信每日限额", value: moneyText(payload.wechatDailyLimitFen) },
        {
          label: "收款二次复核阈值",
          value:
            payload.receiptSecondReviewFen === null
              ? "未启用"
              : moneyText(payload.receiptSecondReviewFen),
        },
        { label: "微信发货上报", value: payload.shippingReport ? "开启" : "关闭" },
      ]}
    />
  );
}
