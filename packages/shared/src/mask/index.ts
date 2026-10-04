// 脱敏展示的纯函数：前后端共用规则，由后端执行（D4 第 9.3 节）。规则与例子见规范 第 7 节“脱敏”表。
// 入参太短、照规则留不出头尾时整串打码，不多露一位。库里的脱敏列由 W0-14 写，调的是这里的函数。

const FOUR = "****";

/** 留前 head 位与末 tail 位，中间固定 4 个星号（不暴露原长）；留不出头尾时整串打码 */
function keepEnds(value: string, head: number, tail: number): string {
  const chars = Array.from(value.trim());
  if (chars.length <= head + tail) return FOUR;
  return `${chars.slice(0, head).join("")}${FOUR}${chars.slice(chars.length - tail).join("")}`;
}

/** 手机号：留前 3 后 4 → 138****5678 */
export function maskPhone(phone: string): string {
  return keepEnds(phone, 3, 4);
}

/** 姓名：留姓（按第一个字）→ 王** */
export function maskName(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? "" : `${first}**`;
}

/** 统一社会信用代码：留前 12 位与末 2 位 → 91510104MA6B****2R */
export function maskUscc(code: string): string {
  return keepEnds(code, 12, 2);
}

/**
 * 邮箱：留前缀的前一半（向上取整，至多 7 位）与域名 → yunjian****@163.com。
 * 前缀不整个露出：只有 1 位时一位不留 → ****@x.com
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return FOUR;
  const local = Array.from(trimmed.slice(0, at));
  const keep = Math.min(7, Math.ceil(local.length / 2), local.length - 1);
  return `${local.slice(0, keep).join("")}${FOUR}${trimmed.slice(at)}`;
}

/** 座机：留区号与末 4 位 → 028-****3321。没写连字符时按 01x、02x 三位、其余四位取区号 */
export function maskLandline(landline: string): string {
  const [first = "", second] = landline.trim().split("-");
  const digitsOf = (text: string): string => text.replace(/\D/g, "");
  let area = digitsOf(first);
  let number = second === undefined ? "" : digitsOf(second);
  if (second === undefined) {
    const areaLength = /^0[12]/.test(area) ? 3 : area.startsWith("0") ? 4 : 0;
    number = area.slice(areaLength);
    area = area.slice(0, areaLength);
  }
  const tail = number.length > 4 ? number.slice(-4) : "";
  return area === "" ? `${FOUR}${tail}` : `${area}-${FOUR}${tail}`;
}

/** 银行账号：只留末 4 位 → ****6688。银行名由调用方拼在前面（“招商银行 ****6688”） */
export function maskBankAccount(account: string): string {
  const digits = account.replace(/\s/g, "");
  return digits.length > 4 ? `${FOUR}${digits.slice(-4)}` : FOUR;
}

/** 许可证编号：末 6 位打码 → JY25101040****** */
export function maskLicenseNo(licenseNo: string): string {
  const chars = Array.from(licenseNo.trim());
  const hidden = Math.min(6, chars.length);
  return `${chars.slice(0, chars.length - hidden).join("")}${"*".repeat(hidden)}`;
}

/** IP：隐去第三段 → 182.139.**.52（D4 第 9.3 节）。不是四段点分地址时整串打码 */
export function maskIp(ip: string): string {
  const parts = ip.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return "**";
  return `${parts[0]}.${parts[1]}.**.${parts[3]}`;
}
