import { failed, ok, SMS_TEMPLATE_PARAMS, SMS_TODO_ITEMS } from "../types.js";
import type { SmsProvider, SmsSendResult, SmsTemplateBinding } from "../types.js";
import { createSmsHttp, isRecord, opaque } from "./http.js";
import type { SmsHttpOptions } from "./http.js";

const uncertainCode = (code: string | undefined) => !code || code.startsWith("InternalError");

export interface TencentSmsOptions extends SmsHttpOptions {
  readonly getTemplate: (key: string) => Promise<SmsTemplateBinding | null>;
}
export function createTencentSms(options: TencentSmsOptions): SmsProvider {
  const call = createSmsHttp(options);
  const send = async ({
    phones,
    template,
    params,
    signal,
  }: {
    phones: readonly string[];
    template: SmsTemplateBinding;
    params: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<SmsSendResult> => {
    const rejection = (message: string): SmsSendResult => ({
      ...failed("rejected", message),
      acceptance: "not_accepted",
    });
    if (signal?.aborted)
      return { ...failed("unavailable", "短信请求已取消"), acceptance: "not_accepted" };
    const normalized = phones.map((phone) => (/^1[3-9]\d{9}$/.test(phone) ? `+86${phone}` : phone));
    if (
      normalized.length < 1 ||
      normalized.length > 200 ||
      new Set(normalized).size !== normalized.length ||
      normalized.some((phone) => !/^\+861[3-9]\d{9}$/.test(phone))
    )
      return rejection("短信仅接受合法中国大陆号码");
    if (template.status !== "active") return rejection("短信模板未生效");
    if (
      !template.providerTemplateId ||
      !/^\d{1,32}$/.test(template.providerTemplateId) ||
      !template.signName ||
      !/^[\p{Script=Han}A-Za-z0-9]{2,12}$/u.test(template.signName)
    )
      return { ...failed("unconfigured", "短信模板或签名未配置"), acceptance: "not_accepted" };
    const expected = Object.hasOwn(SMS_TEMPLATE_PARAMS, template.templateKey)
      ? SMS_TEMPLATE_PARAMS[template.templateKey]
      : undefined;
    if (
      !expected ||
      template.kind !== (template.templateKey === "verify_code" ? "verify" : "notice") ||
      expected.length !== template.params.length ||
      expected.some(
        (field, i) =>
          field.name !== template.params[i]?.name ||
          (template.params[i]?.maxLen ?? Infinity) > field.maxLen,
      )
    )
      return rejection("短信绑定不合固定模板定义");
    if (
      template.params.length > 8 ||
      new Set(template.params.map((p) => p.name)).size !== template.params.length ||
      Object.keys(params).length !== template.params.length
    )
      return rejection("短信变量与批准模板不一致");
    const values: string[] = [];
    for (const field of template.params) {
      const value = params[field.name];
      if (
        !/^[a-z][a-z0-9_]{0,31}$/.test(field.name) ||
        !Number.isSafeInteger(field.maxLen) ||
        field.maxLen < 1 ||
        field.maxLen > 128 ||
        !Object.hasOwn(params, field.name) ||
        typeof value !== "string" ||
        !value ||
        [...value].length > field.maxLen ||
        [...value].some((character) => character.codePointAt(0)! < 32) ||
        /(?:https?:\/\/|www\.)/i.test(value)
      )
        return rejection("短信变量缺失、过长或不合规");
      if (
        ["date", "expiry_date", "offline_date"].includes(field.name) &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
          new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
      )
        return rejection("短信日期变量不合规");
      if (field.name === "points" && !/^\d{1,12}$/.test(value))
        return rejection("短信积分变量不合规");
      values.push(value);
    }
    if (
      template.templateKey === "generic_todo" &&
      !SMS_TODO_ITEMS.some((item) => item === params["item"])
    )
      return rejection("兜底短信事项须来自固定枚举");
    if (template.kind === "verify" && (values.length !== 1 || !/^\d{1,6}$/.test(values[0] ?? "")))
      return rejection("腾讯云验证码变量仅接受至多6位纯数字；员工激活码不兼容");
    const response = await call(
      "SendSms",
      {
        SmsSdkAppId: options.config.sdkAppId,
        SignName: template.signName,
        TemplateId: template.providerTemplateId,
        TemplateParamSet: values,
        PhoneNumberSet: normalized,
      },
      signal,
    );
    if (!response.ok) return { ...response, acceptance: "unknown" };
    const requestId = opaque(response.value["RequestId"]);
    const error = response.value["Error"];
    if (isRecord(error)) {
      const providerCode = opaque(error["Code"]);
      const uncertain = uncertainCode(providerCode);
      return {
        ...failed(
          uncertain ? "unavailable" : "rejected",
          uncertain ? "腾讯云响应未确定受理结果" : "腾讯云明确拒绝短信请求",
        ),
        ...(providerCode ? { providerCode } : {}),
        ...(requestId ? { requestId } : {}),
        acceptance: uncertain ? "unknown" : "not_accepted",
      };
    }
    const statuses = response.value["SendStatusSet"];
    if (!Array.isArray(statuses) || statuses.length !== normalized.length || !requestId)
      return { ...failed("unavailable", "短信响应缺少匹配的投递结果"), acceptance: "unknown" };
    let firstId: string | undefined;
    const seen = new Set<string>();
    let rejectedCode: string | undefined;
    let hasFailure = false;
    let uncertainStatus = false;
    for (const candidate of statuses as unknown[]) {
      if (
        !isRecord(candidate) ||
        typeof candidate["PhoneNumber"] !== "string" ||
        !normalized.includes(candidate["PhoneNumber"]) ||
        seen.has(candidate["PhoneNumber"])
      )
        return {
          ...failed("unavailable", "短信响应缺少匹配的投递结果"),
          requestId,
          acceptance: "unknown",
        };
      seen.add(candidate["PhoneNumber"]);
      const code = opaque(candidate["Code"]);
      if (code !== "Ok") {
        hasFailure = true;
        uncertainStatus ||= uncertainCode(code);
        rejectedCode ??= code;
        continue;
      }
      const id = opaque(candidate["SerialNo"]);
      if (!id)
        return {
          ...failed("unavailable", "短信响应缺少真实投递编号"),
          requestId,
          acceptance: "unknown",
        };
      firstId ??= id;
    }
    if (hasFailure) {
      const uncertain = uncertainStatus || firstId !== undefined;
      return {
        ...failed(
          uncertain ? "unavailable" : "rejected",
          uncertain ? "腾讯云响应未确定全部受理结果" : "腾讯云明确拒绝短信投递",
        ),
        ...(rejectedCode ? { providerCode: rejectedCode } : {}),
        requestId,
        acceptance: uncertain ? "unknown" : "not_accepted",
      };
    }
    if (!firstId)
      return {
        ...failed("unavailable", "短信响应缺少真实投递编号"),
        requestId,
        acceptance: "unknown",
      };
    return ok({ requestId, providerMsgId: firstId });
  };
  const legacy = async (phones: readonly string[], key: string, params: Record<string, string>) => {
    let template;
    try {
      template = await options.getTemplate(key);
    } catch {
      return failed("unavailable", "短信模板读取失败，未发起外呼");
    }
    if (!template) return failed("unconfigured", "短信模板未配置");
    const result = await send({ phones, template, params });
    return result.ok ? ok(undefined) : result;
  };
  return {
    status: "tencent",
    configured: true,
    sendTemplate: ({ phone, ...input }) => send({ ...input, phones: [phone] }),
    async checkBalance() {
      return failed("unsupported", "尚无账号完整套餐范围与正式阈值，禁止推断账号总余量");
    },
    sendActivationCode: ({ phone, code }) =>
      /^\d{1,6}$/.test(code)
        ? legacy([phone], "verify_code", { code })
        : Promise.resolve(
            failed("rejected", "腾讯云验证码变量仅接受至多6位纯数字；员工激活码不兼容"),
          ),
    sendSubscribeFallback: ({ phone, templateKey, params }) => legacy([phone], templateKey, params),
    sendOncallAlert: ({ phones, title }) => legacy(phones, "ops_alert", { rule_name: title }),
  };
}
