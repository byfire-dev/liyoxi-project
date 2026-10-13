import { z } from "zod";
import type { BusinessLicenseFields } from "../types.js";

const text = (max: number) => z.string().max(max).optional();
const responseSchema = z.object({
  RequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  Name: text(256),
  RegNum: text(64),
  Person: text(256),
  Address: text(2000),
  Business: text(2000),
  Type: text(256),
  Period: text(256),
  RecognizeWarnCode: z
    .array(z.union([z.number().int(), z.bigint()]))
    .max(16)
    .optional(),
  RecognizeWarnMsg: z.array(z.string().max(128)).max(16).optional(),
});

function date(value: string): string | undefined {
  const match = /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  if (year < 1900 || year > 9999) return undefined;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : undefined;
}

function validity(value: string): Pick<BusinessLicenseFields, "validFrom" | "validTo"> {
  const text = value.replace(/\s/g, "");
  if (text === "长期") return { validTo: "long_term" };
  const match =
    /^(\d{4}(?:-\d{1,2}-\d{1,2}|年\d{1,2}月(?:\d{1,2}日?)?))(?:至|到|~|—)(长期|\d{4}(?:-\d{1,2}-\d{1,2}|年\d{1,2}月\d{1,2}日?))$/.exec(
      text,
    );
  if (!match) return {};
  const from = date(match[1]!);
  const to = match[2] === "长期" ? "long_term" : date(match[2]!);
  const monthOnly = /^(\d{4})年(\d{1,2})月$/.exec(match[1]!);
  const validMonth =
    monthOnly &&
    Number(monthOnly[1]) >= 1900 &&
    Number(monthOnly[2]) >= 1 &&
    Number(monthOnly[2]) <= 12;
  if ((!from && !validMonth) || !to || (from && to !== "long_term" && from > to)) return {};
  return { ...(from ? { validFrom: from } : {}), validTo: to };
}

function subjectType(value: string): NonNullable<BusinessLicenseFields["subjectType"]> {
  const type = value.trim().replace(/\s/g, "").replaceAll("(", "（").replaceAll(")", "）");
  if (type === "个体工商户") return "individual";
  if (/^(?:[^（）]*分公司|[^（）]*分支机构)$/.test(type)) return "branch";
  if (
    /^(?:有限责任公司|股份有限公司|个人独资企业|合伙企业|普通合伙企业|有限合伙企业|全民所有制|集体所有制|农民专业合作社|企业法人)(?:（[^（）]{1,128}）)?$/.test(
      type,
    )
  )
    return "enterprise";
  return "unknown";
}

/** 只映射官方实际字段；未知类型和无法解析的期限留原文，不猜置信度/日期。 */
export function parseBusinessLicense(raw: unknown): BusinessLicenseFields | undefined {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  const name = data.Name?.trim() ?? "",
    uscc = data.RegNum?.trim() ?? "",
    principal = data.Person?.trim() ?? "";
  if (!name && !uscc && !principal) return undefined;
  const warnings = new Set<string>();
  const type = subjectType(data.Type ?? "");
  for (const code of data.RecognizeWarnCode ?? []) {
    if (code === -9102 || code === -9102n) warnings.add("WARN_COPY_CARD");
    else if (code === -9104 || code === -9104n) warnings.add("WARN_RESHOOT_CARD");
    else warnings.add(`PROVIDER_WARNING_${String(code).slice(0, 32)}`);
  }
  for (const warning of data.RecognizeWarnMsg ?? [])
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(warning)) warnings.add(warning);
  return {
    name,
    uscc,
    principal,
    ...(data.Address ? { address: data.Address.trim() } : {}),
    subjectType: type,
    ...(type === "enterprise"
      ? { principalRole: "legal_rep" as const }
      : type === "individual"
        ? { principalRole: "operator" as const }
        : type === "branch"
          ? { principalRole: "branch_head" as const }
          : {}),
    ...(data.Business ? { businessScope: data.Business } : {}),
    raw: JSON.stringify(raw, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    ...(data.Type ? { subjectTypeText: data.Type } : {}),
    ...(data.Period ? { periodText: data.Period, ...validity(data.Period) } : {}),
    warnings: [...warnings],
  };
}
