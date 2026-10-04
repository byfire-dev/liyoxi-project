// 《定制内容授权书》模板：只读 snapshot 取数（D6 第 3.5.1 节），不查库。
// 版面：标题、要素表、三段条款、同意记录一行、落款；页脚印编号、版次、内容指纹、页码，验真二维码画占位方块。
// 不做数字签名与印章外观（G5-B）。每页页眉标“占位，非法务定稿”。
//
// 不写 JSX：Node 24 能直接跑 .ts，但不认 .tsx；用 createElement 省掉一步编译。
import { createElement as h, type ReactElement, type ReactNode } from "react";

import { Document, type DocumentProps, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

import { type Clause, clauseFor } from "./clauses.ts";
import { BODY_FAMILY, HEADING_FAMILY } from "./fonts.ts";
import { IDEOGRAPHIC_SPACE, noBreakSpaces } from "./linebreak.ts";
import type { LicenseSnapshot, Platform } from "./snapshot.ts";

export const TEMPLATE_VERSION = "x03-spike-1";

/** 每页页眉的占位标记（任务书 第 5 节） */
export const PLACEHOLDER_MARK = "占位，非法务定稿";

// A4：595.28 × 841.89 pt。正文五号字（10.5pt），一行排 46 个汉字，版心宽度正好是字号的整数倍，
// 纯汉字的行左右都齐。
const FONT_SIZE = 10.5;
const CHARS_PER_LINE = 46;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = FONT_SIZE * CHARS_PER_LINE;
const SIDE = (PAGE_WIDTH - CONTENT_WIDTH) / 2;
const PADDING_TOP = 58;
const PADDING_BOTTOM = 88;
const LABEL_WIDTH = 92;
const BORDER = 0.6;

/** 版心的位置，给用例核对“不溢出页边”用 */
export const LAYOUT = {
  side: SIDE,
  contentWidth: CONTENT_WIDTH,
  paddingTop: PADDING_TOP,
  paddingBottom: PADDING_BOTTOM,
} as const;

const styles = StyleSheet.create({
  page: {
    paddingTop: PADDING_TOP,
    paddingBottom: PADDING_BOTTOM,
    paddingHorizontal: SIDE,
    fontFamily: BODY_FAMILY,
    fontSize: FONT_SIZE,
    lineHeight: 1.75,
    color: "#000000",
  },
  header: {
    position: "absolute",
    top: 26,
    left: SIDE,
    right: SIDE,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    lineHeight: 1.3,
    color: "#555555",
    borderBottomWidth: 0.4,
    borderBottomColor: "#999999",
    paddingBottom: 4,
  },
  title: {
    fontFamily: HEADING_FAMILY,
    fontWeight: 700,
    fontSize: 20,
    lineHeight: 1.4,
    textAlign: "center",
    letterSpacing: 2,
  },
  subtitle: { fontSize: 9, textAlign: "center", color: "#333333", marginBottom: 8 },
  paragraph: { marginBottom: 5 },
  table: { marginTop: 4, marginBottom: 8 },
  row: {
    flexDirection: "row",
    borderWidth: BORDER,
    borderColor: "#000000",
    marginTop: -BORDER,
  },
  labelCell: {
    width: LABEL_WIDTH,
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRightWidth: BORDER,
    borderRightColor: "#000000",
    backgroundColor: "#f2f2f2",
    fontWeight: 700,
    fontSize: 10,
    lineHeight: 1.5,
  },
  valueCell: {
    width: CONTENT_WIDTH - LABEL_WIDTH - BORDER * 2,
    paddingVertical: 3,
    paddingHorizontal: 6,
    fontSize: 10,
    lineHeight: 1.5,
  },
  clauseTitle: {
    fontFamily: HEADING_FAMILY,
    fontWeight: 700,
    fontSize: 12,
    lineHeight: 1.5,
    marginTop: 8,
    marginBottom: 5,
  },
  bold: { fontWeight: 700 },
  consent: {
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: BORDER,
    borderColor: "#000000",
    fontSize: 10,
    lineHeight: 1.6,
  },
  signOff: { marginTop: 16, alignItems: "flex-end" },
  signOffLine: { width: 300, marginBottom: 2 },
  footer: {
    position: "absolute",
    bottom: 30,
    left: SIDE,
    right: SIDE,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderTopWidth: 0.4,
    borderTopColor: "#999999",
    paddingTop: 6,
  },
  footerText: { width: CONTENT_WIDTH - 52 },
  // 页脚的字由渲染回调现生成。做法是 View 带 render、行高写在回调返回的 Text 自己身上。
  // 别的写法（Text 带 render；或返回的 Text 靠继承取行高）每重排一遍行高就被再乘一次字号，
  // 字被排到页面外面，回调却照常被调用（test/engine-facts.test.ts）
  footerLine: { fontSize: 7.5, lineHeight: 1.5, color: "#333333" },
  qrBox: {
    width: 40,
    height: 40,
    borderWidth: 0.8,
    borderColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  qrText: { fontSize: 6, lineHeight: 1.3, textAlign: "center", color: "#333333" },
});

const PLATFORM_NAME: Record<Platform, string> = { douyin: "抖音", channels: "视频号" };

/** “2026-12-31” 或带时区的时间 → “2026 年 12 月 31 日”（按北京时间取日期） */
function formatDate(value: string): string {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return `${plain[1]} 年 ${Number(plain[2])} 月 ${Number(plain[3])} 日`;
  const beijing = new Date(Date.parse(value) + 8 * 3600 * 1000);
  return `${beijing.getUTCFullYear()} 年 ${beijing.getUTCMonth() + 1} 月 ${beijing.getUTCDate()} 日`;
}

/** 带时区的时间 → “2026 年 9 月 26 日 10:32:05（北京时间）” */
function formatDateTime(value: string): string {
  const beijing = new Date(Date.parse(value) + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
  return `${formatDate(value)} ${time}（北京时间）`;
}

export interface FooterInfo {
  pageNumber: number;
  totalPages: number;
  /** 这一页页脚印的两行字 */
  lines: [string, string];
}

export interface TemplateProps {
  snapshot: LicenseSnapshot;
  fingerprint: string;
  /** 过一遍文字：把字体没收的字换成替代符号（由 render.ts 传入） */
  clean: (text: string) => string;
  /** 页脚渲染回调每页调一次，把页码与页脚文字交出去（任务书 第 11 节第 5 项） */
  onFooter: (info: FooterInfo) => void;
}

/** 页脚的两行字。不用换行符拼成一个 Text：换行符在字体里没有字形，引擎会为它引入未嵌入的 Helvetica */
export function footerLines(
  snapshot: Pick<LicenseSnapshot, "letterNo" | "revNo">,
  fingerprint: string,
  pageNumber: number,
  totalPages: number,
): [string, string] {
  return [
    `编号 ${snapshot.letterNo} · 第 ${snapshot.revNo} 版 · 第 ${pageNumber} 页 / 共 ${totalPages} 页`,
    `内容指纹 ${fingerprint}`,
  ];
}

export function LicenseLetter(props: TemplateProps): ReactElement<DocumentProps> {
  const { snapshot, fingerprint, onFooter } = props;
  /** 所有要印的文字都过这一道：换掉缺字，普通空格换成不换行空格 */
  const t = (text: string) => noBreakSpaces(props.clean(text));

  /** 把 **…** 标出的片段排成加粗 */
  const rich = (text: string): ReactNode[] =>
    text
      .split(/\*\*(.+?)\*\*/)
      .map((part, index) =>
        index % 2 === 1 ? h(Text, { key: index, style: styles.bold }, t(part)) : t(part),
      )
      .filter((part) => part !== "");

  const row = (label: string, ...lines: string[]) =>
    h(
      View,
      { style: styles.row, wrap: false, key: label },
      h(View, { style: styles.labelCell }, h(Text, null, t(label))),
      h(
        View,
        { style: styles.valueCell },
        ...lines.map((line, index) => h(Text, { key: index }, t(line))),
      ),
    );

  const clause = (key: string) => {
    const { title, items }: Clause = clauseFor(key);
    return h(
      View,
      { key },
      // 条款标题不单独留在页尾：标题后面至少还要放得下两三行正文，否则整体挪到下一页
      h(Text, { style: styles.clauseTitle, minPresenceAhead: 60 }, t(title)),
      ...items.map((item, index) =>
        h(Text, { key: index, style: styles.paragraph }, ...rich(item)),
      ),
    );
  };

  const { licensor, licensee, drama, account, period, consent } = snapshot;
  const permits = drama.permits;
  const periodText =
    period.start === null
      ? `${period.startText}至 ${formatDate(period.end)}`
      : `${formatDate(period.start)}至 ${formatDate(period.end)}`;

  return h(
    Document,
    {
      title: `定制内容授权书 ${snapshot.letterNo} 第 ${snapshot.revNo} 版`,
      author: licensor.name,
      subject: `内容指纹 ${fingerprint}`,
      language: "zh-CN",
    },
    h(
      Page,
      { size: "A4", style: styles.page },
      h(
        View,
        { style: styles.header, fixed: true },
        h(
          Text,
          null,
          t(`模板 ${TEMPLATE_VERSION} · 未签名（数字签名与印章外观不在本次验证范围内）`),
        ),
        h(Text, null, t(PLACEHOLDER_MARK)),
      ),

      h(Text, { style: styles.title }, t("定制内容授权书")),
      h(
        Text,
        { style: styles.subtitle },
        t(`编号：${snapshot.letterNo}${IDEOGRAPHIC_SPACE}第 ${snapshot.revNo} 版`),
      ),
      h(
        Text,
        { style: styles.paragraph },
        t(
          "授权方依其对下列剧目享有的权利，就被授权方订购的定制内容，按本授权书载明的要素与条款，向被授权方出具本授权书。",
        ),
      ),

      h(
        View,
        { style: styles.table },
        row("授权方", licensor.name, `统一社会信用代码：${licensor.creditCode}`),
        row(
          "被授权方",
          licensee.name,
          `统一社会信用代码：${licensee.creditCode}`,
          `下单门店：${licensee.store}`,
        ),
        row("授权剧目", `《${drama.name}》，共 ${drama.episodes} 集`),
        ...permits.map((permit, index) =>
          row(
            permits.length > 1 ? `许可信息 ${index + 1}` : "许可信息",
            `${permit.kind}：${permit.number}（${PLATFORM_NAME[permit.platform]}）`,
          ),
        ),
        row(
          "发布账号",
          `平台：${PLATFORM_NAME[account.platform]}`,
          `账号名称：${account.name}`,
          `账号 ID：${account.accountId}`,
        ),
        row("授权期限", periodText),
        row("授权地域", period.territory),
        row("验真地址", snapshot.verifyUrl),
      ),

      clause(snapshot.rightsClauseKey),
      clause(snapshot.exclusiveClauseKey),
      clause(snapshot.obligationClauseKey),

      // 同意记录与落款放在一个不拆的块里：落款不会单独落到一页上
      h(
        View,
        { wrap: false },
        h(
          View,
          { style: styles.consent },
          h(
            Text,
            null,
            h(Text, { style: styles.bold }, t("同意记录")),
            t(
              `${IDEOGRAPHIC_SPACE}被授权方已于 ${formatDateTime(consent.at)}在线同意《${consent.agreement}》；` +
                `同意记录编号 ${consent.consentId}；操作人 ${consent.by}。`,
            ),
          ),
        ),
        h(
          View,
          { style: styles.signOff },
          h(Text, { style: styles.signOffLine }, t(`授权方（电子签章）：${licensor.name}`)),
          h(Text, { style: styles.signOffLine }, t(`出具日期：${formatDate(snapshot.issuedAt)}`)),
        ),
      ),

      h(
        View,
        { style: styles.footer, fixed: true },
        h(View, {
          style: styles.footerText,
          render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages?: number }) => {
            // 第一遍排版时总页数还没算出来，回调拿到的是 undefined；只在第二遍把结果交出去
            if (totalPages === undefined) return null;
            const lines = footerLines(snapshot, fingerprint, pageNumber, totalPages);
            onFooter({ pageNumber, totalPages, lines });
            return lines.map((line, index) =>
              h(Text, { key: index, style: styles.footerLine }, noBreakSpaces(line)),
            );
          },
        }),
        h(
          View,
          { style: styles.qrBox },
          h(Text, { style: styles.qrText }, "验真二维码"),
          h(Text, { style: styles.qrText }, "（占位）"),
        ),
      ),
    ),
  );
}
