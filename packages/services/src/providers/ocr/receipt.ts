import { z } from "zod";

const field = z.string().max(2000).nullable();
export const BankReceiptFieldsSchema = z.strictObject({
  payerName: field,
  payerAccount: z
    .string()
    .regex(/^\d{10,32}$/)
    .nullable(),
  payeeName: field,
  amountFen: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  remark: field,
  tradedAt: z.iso.datetime().nullable(),
  warnings: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,80}$/)).max(32),
  raw: z
    .string()
    .max(1024 * 1024)
    .optional(),
});
export type BankReceiptFields = z.infer<typeof BankReceiptFieldsSchema>;
const response = z.object({
  RequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  BankSlipInfos: z
    .array(z.object({ Name: z.string().max(128), Value: z.string().max(2000) }))
    .max(256),
});
function amount(value: string | null, currency: string | null): number | null {
  if (!value || !["人民币", "CNY", "RMB"].includes(currency ?? "")) return null;
  const match = /^(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const fen =
    BigInt(match[1]!.replaceAll(",", "")) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return fen <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fen) : null;
}
function instant(value: string | null): string | null {
  // 官方日期示例不含时分秒/时区；不能猜成零点或擅自补北京时间。
  const parsed = z.iso.datetime({ offset: true }).safeParse(value);
  if (!parsed.success) return null;
  const date = new Date(parsed.data);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/** 官方BankSlipInfo已明确的Name白名单；不猜户名/备注别名，不从raw补字段。 */
export function parseBankReceipt(raw: unknown): BankReceiptFields | undefined {
  const parsed = response.safeParse(raw);
  if (!parsed.success || parsed.data.BankSlipInfos.length === 0) return undefined;
  const warnings = new Set<string>();
  const get = (name: string): string | null => {
    const values = [
      ...new Set(
        parsed.data.BankSlipInfos.filter((item) => item.Name === name)
          .map((item) => item.Value.trim())
          .filter(Boolean),
      ),
    ];
    if (values.length > 1) warnings.add("CONFLICTING_FIELD");
    return values.length === 1 ? values[0]! : null;
  };
  const account = get("付款账号")?.replace(/\s/g, "") ?? null;
  const payerAccount = account && /^\d{10,32}$/.test(account) ? account : null;
  const amountFen = amount(get("交易金额"), get("币种"));
  const tradedAt = instant(get("日期"));
  if (payerAccount === null && amountFen === null && tradedAt === null) return undefined;
  for (const key of ["PAYER_NAME", "PAYEE_NAME", "REMARK"]) warnings.add(`MISSING_${key}`);
  if (payerAccount === null) warnings.add("MISSING_OR_INVALID_PAYER_ACCOUNT");
  if (amountFen === null) warnings.add("MISSING_OR_UNCERTAIN_AMOUNT");
  if (tradedAt === null) warnings.add("MISSING_OR_UNCERTAIN_TRADED_AT");
  return {
    payerName: null,
    payerAccount,
    payeeName: null,
    amountFen,
    remark: null,
    tradedAt,
    warnings: [...warnings],
    raw: JSON.stringify(raw, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  };
}
