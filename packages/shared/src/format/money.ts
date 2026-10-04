// 子路径 @liyoxi/shared/format/money：金额、积分、增减号的格式化；“元”字符串转分。
//
// 依据：规范 第 7 节“金额”“积分”“增减”三行、第 14 节第 8 项；约定 第 5 节 C31。
//   金额  “¥”开头，不留空格，千分位。整数不带小数、非整数两位（商家端全部金额；后台的标价与门槛）；
//         固定两位（后台的交易、对账、结算金额）
//   积分  整数，千分位，数字与“积分”之间留一个空格
//   增减  积分与金额：获得用全角“＋”，扣减用“−”（U+2212）。百分比：半角“+”与“−”
//
// 只有整数与字符串运算：不做浮点的乘除换算，不用 BigInt，不用 Intl（小程序可引）。
// 时间、日期、时长的格式化与脱敏不在这里（W0-26）。

/** 减号“−”（U+2212），不是连字符 */
const MINUS = "−";
/** 全角加号“＋” */
const FULLWIDTH_PLUS = "＋";

const YUAN_INPUT = /^(\d+)(?:\.(\d{1,2}))?$/;
const MONEY_DISPLAY = /^([−＋]?)¥(\d{1,3}(?:,\d{3})*)(?:\.(\d{2}))?$/;

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`格式化：${label}必须是整数，收到 ${String(value)}`);
  }
  return value;
}

const groupThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 分 → “3,000”或“3,000.50”，不带符号与“¥” */
function yuanText(absFen: number, fixed: boolean): string {
  const cents = absFen % 100;
  const whole = groupThousands(String((absFen - cents) / 100));
  return fixed || cents !== 0 ? `${whole}.${String(cents).padStart(2, "0")}` : whole;
}

function money(fen: number, fixed: boolean, plus: string): string {
  integer(fen, "金额（分）");
  const sign = fen < 0 ? MINUS : fen > 0 ? plus : "";
  return `${sign}¥${yuanText(Math.abs(fen), fixed)}`;
}

/** 整数加千分位：2160 → “2,160”；负数用“−” */
export function formatInteger(value: number): string {
  integer(value, "数值");
  return `${value < 0 ? MINUS : ""}${groupThousands(String(Math.abs(value)))}`;
}

/** 金额：整数不带小数，非整数两位。300000 → “¥3,000”，300050 → “¥3,000.50” */
export function formatMoney(fen: number): string {
  return money(fen, false, "");
}

/** 金额：固定两位小数。300000 → “¥3,000.00” */
export function formatMoneyFixed(fen: number): string {
  return money(fen, true, "");
}

/** 积分：2160 → “2,160 积分” */
export function formatPoints(points: number): string {
  return `${formatInteger(points)} 积分`;
}

/** 积分增减：1000 → “＋1,000”，−180 → “−180”，0 → “0” */
export function formatSignedPoints(delta: number): string {
  return `${delta > 0 ? FULLWIDTH_PLUS : ""}${formatInteger(delta)}`;
}

/** 金额增减，整数不带小数：100000 → “＋¥1,000”，−18000 → “−¥180”。符号写在“¥”前 */
export function formatSignedMoney(fen: number): string {
  return money(fen, false, FULLWIDTH_PLUS);
}

/** 金额增减，固定两位小数：−18000 → “−¥180.00” */
export function formatSignedMoneyFixed(fen: number): string {
  return money(fen, true, FULLWIDTH_PLUS);
}

/**
 * 百分比增减，入参是万分比：1110 → “+11.1%”，−250 → “−2.5%”，0 → “0%”。
 * 万分比换成百分数最多两位小数，末尾的 0 不写；要保留几位由调用方先取整到对应的万分比。
 */
export function formatSignedPercent(bp: number): string {
  integer(bp, "比例（万分比）");
  const abs = Math.abs(bp);
  const fraction = abs % 100;
  const whole = groupThousands(String((abs - fraction) / 100));
  const decimals = String(fraction).padStart(2, "0").replace(/0+$/, "");
  const sign = bp < 0 ? MINUS : bp > 0 ? "+" : "";
  return `${sign}${whole}${decimals === "" ? "" : `.${decimals}`}%`;
}

function digitsToFen(wholeDigits: string, fractionDigits: string, source: string): number {
  // 按字符串拆分：整数部分 × 100 + 小数部分右补零。不用浮点乘 100（0.29 × 100 是 28.999…）
  const fen = Number(wholeDigits) * 100 + Number(fractionDigits.padEnd(2, "0"));
  if (!Number.isSafeInteger(fen)) throw new RangeError(`金额：超出范围：${source}`);
  return fen;
}

/**
 * 后台输入的“元”转“分”：只收非负数字，最多两位小数，如 “3000”“0.29”“19.9”。
 * 不收符号、千分位、空格与“¥”；不合法即抛错。
 */
export function yuanToFen(text: string): number {
  const match = typeof text === "string" ? YUAN_INPUT.exec(text) : null;
  if (!match) throw new RangeError(`金额：不是最多两位小数的非负数：${String(text)}`);
  return digitsToFen(match[1] ?? "", match[2] ?? "", text);
}

/** “分”转回输入框里的“元”：固定两位小数，不带千分位与“¥”。29 → “0.29”，110 → “1.10” */
export function fenToYuan(fen: number): string {
  if (integer(fen, "金额（分）") < 0) throw new RangeError(`金额：不能为负：${fen}`);
  const cents = fen % 100;
  return `${String((fen - cents) / 100)}.${String(cents).padStart(2, "0")}`;
}

/** 把本文件输出的金额显示串解析回“分”：“¥3,000”“¥3,000.00”“−¥180”“＋¥1,000” */
export function parseMoney(display: string): number {
  const match = typeof display === "string" ? MONEY_DISPLAY.exec(display) : null;
  if (!match) throw new RangeError(`金额：不是金额显示串：${String(display)}`);
  const fen = digitsToFen((match[2] ?? "").replace(/,/g, ""), match[3] ?? "", display);
  return match[1] === MINUS && fen !== 0 ? -fen : fen;
}
