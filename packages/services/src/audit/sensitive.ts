// 审计里的敏感键（W0-14；D4 第 8.2 节第 6 条）：全仓只在这一处定义，before、after、meta 里任何一层命中即处理。
//   剔除：口令、令牌、动态码与它的密钥、恢复码、激活码、签名、密文与盲索引。键和值都不留。
//   脱敏：手机号、座机、证照号、统一社会信用代码、税号、银行账号与收款账号、邮箱、法定代表人与负责人姓名；
//         收件信息、企业微信外部联系人标识留不出头尾，整个打码。值换成脱敏串。
// 按键名里的词判断：驼峰与蛇形先拆成小写的词（newPhoneEnc → new、phone、enc）；复数也算（phones、emails）。
// 已经是脱敏值的列（<名>_mask、<名>_last4）原样留。新的敏感字段往下面两张表里加词。
// 库里每个 <名>_enc、<名>_bidx 列的明文名都要命中这里的规则：sensitive.test.ts 照 schema.prisma 逐个核对。
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

/** 留不出头尾的值（几项合在一起的文本、不透明的标识）：整个打码 */
const maskWhole: Mask = () => "****";

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
  // 税号（taxNo、taxpayerNumber）：与统一社会信用代码同一种脱敏
  if (has(words, "tax", "taxpayer") && numbered) return maskUscc;
  // 银行账号、收付款账号、卡号：bankAccount、accountNo、payeeAccount、cardNo。
  // 开户行名称（bankName）、渠道账号（account、accountName、channelAccountId）不算
  const account = has(words, "account") && (numbered || has(words, "bank", "payee", "payer"));
  if (account || has(words, "bankaccount", "iban") || (has(words, "card") && numbered)) {
    return maskBankAccount;
  }
  if (has(words, "email")) return maskEmail;
  if (has(words, "legalrep") || (has(words, "legal") && has(words, "rep"))) return maskName;
  // 证照上的法定代表人、经营者或负责人姓名（principalName）；负责人角色（principalRole）不算
  if (has(words, "principal") && has(words, "name")) return maskName;
  // 纸质发票的收件信息（mailTo：收件人、电话、地址合在一起）
  if (has(words, "mailto") || (has(words, "mail") && has(words, "to"))) return maskWhole;
  // 企业微信外部联系人标识（externalUserid）；成员自己的 userid（wecomUserid）是明文列，不算
  const userId = has(words, "userid") || (has(words, "user") && has(words, "id"));
  if (has(words, "external") && userId) return maskWhole;
  return undefined;
}

/** 键名对应的处理 */
export function sensitiveRule(key: string): SensitiveRule {
  const split = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = split.join("");
  // 复数：以 s 结尾的词另添一个去掉 s 的写法（phones → phone、emails → email、accountNos → no）
  const words = split.flatMap((word) =>
    word.length > 2 && word.endsWith("s") ? [word, word.slice(0, -1)] : [word],
  );
  if (has(words, ...SECRET_WORDS) || SECRET_JOINED.some((word) => joined.includes(word))) {
    return "drop";
  }
  if (has(words, "code") && has(words, ...CODE_KINDS)) return "drop";
  if (has(words, ...MASKED_ALREADY)) return undefined;
  return maskFor(words);
}
