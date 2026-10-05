// 审计里的敏感键（W0-14；D4 第 8.2 节第 6 条）：全仓只在这一处定义，before、after、meta 里任何一层命中即处理。
//   剔除：口令、令牌、动态码与它的密钥、恢复码、激活码、签名、密文与盲索引。键和值都不留。
//   脱敏：手机号、座机、证照号、统一社会信用代码、银行账号、邮箱、法定代表人姓名。值换成脱敏串。
// 按键名里的词判断：驼峰与蛇形先拆成小写的词（newPhoneEnc → new、phone、enc）。
// 已经是脱敏值的列（<名>_mask、<名>_last4）原样留。新的敏感字段往下面两张表里加词。
import {
  maskBankAccount,
  maskEmail,
  maskLandline,
  maskLicenseNo,
  maskName,
  maskPhone,
  maskUscc,
} from "@liyoxi/shared/mask";

type Mask = (value: string) => string;
/** 一个键怎么处理："drop" 剔除；函数是脱敏；undefined 照常 */
export type SensitiveRule = "drop" | Mask | undefined;

const SECRET_WORDS = (
  "password passwd pwd passphrase secret token totp otp mfa recovery credential credentials " +
  "cookie signature captcha enc bidx ciphertext salt"
).split(" ");
/** 动态码、激活码、重置码：这些词与 code 同时出现 */
const CODE_KINDS = ["sms", "verify", "verification", "activation", "reset", "auth"];
const SECRET_JOINED = ["apikey", "privatekey", "secretkey", "signingkey"];
const MASKED_ALREADY = ["mask", "masked", "last4"];

const has = (words: readonly string[], ...any: string[]): boolean =>
  any.some((word) => words.includes(word));

function maskFor(words: readonly string[]): Mask | undefined {
  const numbered = has(words, "no", "number");
  if (has(words, "phone", "mobile", "tel", "telephone")) return maskPhone;
  if (has(words, "landline")) return maskLandline;
  if (has(words, "uscc") || (has(words, "credit") && has(words, "code"))) return maskUscc;
  if (has(words, "idcard", "passport") || (has(words, "id") && has(words, "card"))) {
    return maskLicenseNo;
  }
  if (has(words, "license", "licence", "permit", "cert", "certificate")) {
    // 证照号、许可证编号；证照的名称、类型、有效期不算
    return numbered || has(words, "code") ? maskLicenseNo : undefined;
  }
  // 银行账号、卡号：bankAccount、accountNo、cardNo。开户行名称（bankName）、渠道账号的 id 不算
  const account = has(words, "account") && (numbered || has(words, "bank"));
  if (account || has(words, "bankaccount", "iban") || (has(words, "card") && numbered)) {
    return maskBankAccount;
  }
  if (has(words, "email")) return maskEmail;
  if (has(words, "legalrep") || (has(words, "legal") && has(words, "rep"))) return maskName;
  return undefined;
}

/** 键名对应的处理 */
export function sensitiveRule(key: string): SensitiveRule {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = words.join("");
  if (has(words, ...SECRET_WORDS) || SECRET_JOINED.some((word) => joined.includes(word))) {
    return "drop";
  }
  if (has(words, "code") && has(words, ...CODE_KINDS)) return "drop";
  if (has(words, ...MASKED_ALREADY)) return undefined;
  return maskFor(words);
}
