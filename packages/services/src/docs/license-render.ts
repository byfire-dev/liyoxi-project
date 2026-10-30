import { createElement as h } from "react";
import { Document, Image, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import QRCode from "qrcode";
import { LICENSE_TEMPLATE_CATALOG } from "./license-render-catalog.js";
import type { LicenseTemplateCatalog } from "./license-render-catalog.js";
import { licenseContentFingerprint } from "./license-convergence.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";
import { BODY_FAMILY, HEADING_FAMILY, loadLicenseFonts } from "./license-render-fonts.js";
import type { LicenseRenderIssue } from "./license-render-result.js";
import type { LicensePdfRenderer, LicensePdfRenderResult } from "./license-render-types.js";
import { noBreakSpaces } from "./license-render-text.js";

const styles = StyleSheet.create({
  page: {
    paddingTop: 58,
    paddingBottom: 100,
    paddingHorizontal: 56,
    fontFamily: BODY_FAMILY,
    fontSize: 10.5,
    lineHeight: 1.75,
  },
  title: {
    fontFamily: HEADING_FAMILY,
    fontWeight: 700,
    fontSize: 20,
    lineHeight: 1.4,
    textAlign: "center",
    marginBottom: 14,
  },
  heading: {
    fontFamily: HEADING_FAMILY,
    fontWeight: 700,
    fontSize: 12,
    lineHeight: 1.5,
    marginTop: 8,
    marginBottom: 5,
  },
  row: { borderWidth: 0.5, paddingHorizontal: 6, paddingVertical: 4, marginTop: -0.5 },
  label: { fontFamily: BODY_FAMILY, fontWeight: 700, fontSize: 10.5, lineHeight: 1.75 },
  body: { fontSize: 10.5, lineHeight: 1.75, marginBottom: 5 },
  notice: { position: "absolute", top: 24, left: 56, right: 56, fontSize: 8, lineHeight: 1.3 },
  footer: {
    position: "absolute",
    bottom: 25,
    left: 56,
    right: 56,
    flexDirection: "row",
    alignItems: "flex-end",
    borderTopWidth: 0.4,
    paddingTop: 5,
  },
  footerText: { width: 420 },
  footerLine: { fontFamily: BODY_FAMILY, fontSize: 7, lineHeight: 1.5 },
  qr: { width: 44, height: 44 },
});
const normalize = (value: string) => noBreakSpaces(value.replace(/[\p{Cc}\u2028\u2029]/gu, " "));
const footer = (
  letter: string,
  revision: number,
  fingerprint: string,
  page: number,
  total: number,
) => [
  normalize(`编号 ${letter} · 第 ${revision} 版 · 第 ${page} 页 / 共 ${total} 页`),
  normalize(`内容指纹 ${fingerprint}`),
];

/** No I/O at construction and no legal fallback: E8 absent means configured=false. */
export function createLicensePdfRenderer(
  options: { fontDir?: string; catalog?: LicenseTemplateCatalog } = {},
): LicensePdfRenderer {
  // Copy the injected catalog so later caller mutation cannot change a version's text.
  const catalog: LicenseTemplateCatalog = JSON.parse(
    JSON.stringify(options.catalog ?? LICENSE_TEMPLATE_CATALOG),
  ) as LicenseTemplateCatalog;
  const configured = !!options.fontDir && Object.hasOwn(catalog, "v1");
  let closed = false;
  let closing: Promise<void> | undefined;
  let loaded: ReturnType<typeof loadLicenseFonts> | undefined;
  const stopping = new AbortController();
  const pending = new Set<Promise<LicensePdfRenderResult>>();
  async function run(
    input: Parameters<LicensePdfRenderer["render"]>[0],
  ): Promise<LicensePdfRenderResult> {
    const signal = input.signal
      ? AbortSignal.any([input.signal, stopping.signal])
      : stopping.signal;
    if (signal.aborted) return { ok: false, reason: "aborted" };
    const template = Object.hasOwn(catalog, input.templateVersion)
      ? catalog[input.templateVersion]
      : undefined;
    if (!options.fontDir || !template) return { ok: false, reason: "unconfigured" };
    try {
      const snapshot = parseLicenseLetterSnapshot(input.snapshot);
      // JSON/UTF16 can contain lone surrogates; reject before any lossy normalization or audit persistence.
      const validUtf16 = (value: unknown): boolean =>
        typeof value === "string"
          ? Array.from(value).every((character) => {
              const point = character.codePointAt(0)!;
              return point < 0xd800 || point > 0xdfff;
            })
          : value !== null && typeof value === "object"
            ? Object.values(value).every(validUtf16)
            : true;
      if (!validUtf16(snapshot) || !validUtf16(template)) return { ok: false, reason: "rejected" };
      // Scalar coverage cannot prove shaping for format/joiner/variation sequences.
      const supportedSequences = (value: unknown): boolean =>
        typeof value === "string"
          ? !/[\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u.test(value)
          : value !== null && typeof value === "object"
            ? Object.values(value).every(supportedSequences)
            : true;
      if (!supportedSequences(snapshot) || !supportedSequences(template))
        return { ok: false, reason: "rejected" };
      if (
        !/^[a-f0-9]{64}$/.test(input.contentFingerprint) ||
        licenseContentFingerprint(snapshot) !== input.contentFingerprint
      )
        return { ok: false, reason: "rejected" };
      const glyphFonts = await (loaded ??= loadLicenseFonts(options.fontDir));
      if (signal.aborted) return { ok: false, reason: "aborted" };
      const checked: { value: string; field: string }[] = [];
      const text = (value: string, field = "template") => {
        const normalized = normalize(value);
        checked.push({ value: normalized, field });
        return normalized;
      };
      const rows: { label: string; lines: string[] }[] = [];
      const row = (label: string, ...values: [string, string][]) =>
        rows.push({
          label: text(label),
          lines: values.map(([value, field]) => text(value, field)),
        });
      row(
        "授权方",
        [snapshot.licensor.name, "licensor.name"],
        [snapshot.licensor.creditCode, "licensor.creditCode"],
      );
      row(
        "被授权方",
        [snapshot.licensee.name, "licensee.name"],
        [snapshot.licensee.creditCode, "licensee.creditCode"],
        [snapshot.licensee.store, "licensee.store"],
      );
      row(
        "授权剧目",
        [snapshot.drama.name, "drama.name"],
        [`共 ${snapshot.drama.episodes} 集`, "drama.episodes"],
      );
      for (const permit of snapshot.drama.permits)
        row(
          "许可信息",
          [permit.kind, "drama.permits.kind"],
          [permit.number, "drama.permits.number"],
          [permit.platform, "drama.permits.platform"],
        );
      row(
        "发布账号",
        [snapshot.account.platform === "douyin" ? "抖音" : "视频号", "account.platform"],
        [snapshot.account.name, "account.name"],
        [snapshot.account.accountId, "account.accountId"],
      );
      row(
        "授权期限",
        [
          snapshot.period.start ?? snapshot.period.startText,
          snapshot.period.start ? "period.start" : "period.startText",
        ],
        [snapshot.period.end, "period.end"],
      );
      row("授权地域", [snapshot.period.territory, "period.territory"]);
      row("订单编号", [snapshot.orderNo, "orderNo"]);
      row("验真地址", [snapshot.verifyUrl, "verifyUrl"]);
      row(
        "同意记录",
        [snapshot.consent.consentNo, "consent.consentNo"],
        [snapshot.consent.agreement, "consent.agreement"],
        [snapshot.consent.at, "consent.at"],
        [snapshot.consent.by, "consent.by"],
      );
      row("出具日期", [snapshot.issuedAt, "issuedAt"]);
      const title = text(template.title);
      const notice = text(template.notice);
      const clauses = [
        snapshot.rightsClauseKey,
        snapshot.exclusiveClauseKey,
        snapshot.obligationClauseKey,
      ].map((key) => {
        const clause = template.clauses.find((entry) => entry.key === key);
        if (!clause) throw new Error("正文缺失");
        return {
          title: text(clause.title),
          paragraphs: clause.paragraphs.map((value) => text(value)),
        };
      });
      checked.push(
        ...footer(
          snapshot.letterNo,
          snapshot.revNo,
          input.contentFingerprint,
          1234567890,
          1234567890,
        ).map((value) => ({ value, field: "template" })),
      );
      const missing = new Map<number, { character: string; codePoint: string; fields: string[] }>();
      for (const item of checked)
        for (const character of item.value) {
          const point = character.codePointAt(0)!;
          if (
            (point >= 0xd800 && point <= 0xdfff) ||
            !glyphFonts.every((font) => font.hasGlyphForCodePoint(point))
          ) {
            const previous = missing.get(point);
            if (previous) {
              if (!previous.fields.includes(item.field) && previous.fields.length < 4)
                previous.fields.push(item.field);
            } else
              missing.set(point, {
                character,
                codePoint: `U+${point.toString(16).toUpperCase().padStart(4, "0")}`,
                fields: [item.field],
              });
          }
        }
      if (missing.size) {
        const list = [...missing.values()].slice(0, 32);
        const issue: LicenseRenderIssue = {
          kind: "missing_glyph",
          missing: list,
          totalMissingCodePoints: missing.size,
          truncated: missing.size > list.length,
        };
        while (Buffer.byteLength(JSON.stringify(issue), "utf8") > 7 * 1024 && list.length) {
          list.pop();
          (issue as { truncated: boolean }).truncated = true;
        }
        return { ok: false, reason: "missing_glyph", issue };
      }
      const qr = await QRCode.toDataURL(snapshot.verifyUrl, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 160,
      });
      if (signal.aborted) return { ok: false, reason: "aborted" };
      const pdf = await renderToBuffer(
        h(
          Document,
          { title, subject: input.contentFingerprint, language: "zh-CN" },
          h(
            Page,
            { size: "A4", style: styles.page },
            h(Text, { fixed: true, style: styles.notice }, notice),
            h(Text, { style: styles.title }, title),
            ...rows.map((entry, index) =>
              h(
                View,
                { key: `r${index}`, wrap: false, style: styles.row },
                h(Text, { style: styles.label }, entry.label),
                ...entry.lines.map((line, lineIndex) =>
                  h(Text, { key: lineIndex, style: styles.body }, line),
                ),
              ),
            ),
            ...clauses.flatMap((clause, index) => [
              h(
                Text,
                { key: `h${index}`, minPresenceAhead: 60, style: styles.heading },
                clause.title,
              ),
              ...clause.paragraphs.map((paragraph, paragraphIndex) =>
                h(Text, { key: `p${index}-${paragraphIndex}`, style: styles.body }, paragraph),
              ),
            ]),
            h(
              View,
              { fixed: true, style: styles.footer },
              h(View, {
                style: styles.footerText,
                render: (page) => {
                  // View's public callback type omits the totals supplied by the final
                  // layout pass. Consume that runtime field with a capability guard;
                  // moving this callback to Text breaks ADR-042 footer line heights.
                  const totalPages = "totalPages" in page ? page.totalPages : undefined;
                  if (
                    typeof totalPages !== "number" ||
                    !Number.isSafeInteger(totalPages) ||
                    totalPages < 1
                  )
                    return null;
                  return footer(
                    snapshot.letterNo,
                    snapshot.revNo,
                    input.contentFingerprint,
                    page.pageNumber,
                    totalPages,
                  ).map((line, index) => h(Text, { key: index, style: styles.footerLine }, line));
                },
              }),
              h(Image, { src: qr, style: styles.qr }),
            ),
          ),
        ),
      );
      if (signal.aborted) return { ok: false, reason: "aborted" };
      if (pdf.length > 1_048_576) return { ok: false, reason: "rejected" };
      // Inspect actual emitted BaseFont names, not preflight promises of coverage.
      const parsed = await PDFDocument.load(pdf, { updateMetadata: false });
      let count = 0;
      for (const [, object] of parsed.context.enumerateIndirectObjects())
        if (object instanceof PDFDict) {
          const base = object.get(PDFName.of("BaseFont"));
          if (base) {
            count++;
            if (
              !(base instanceof PDFName) ||
              !/^(?:[A-Z]{6}\+)?(?:NotoSerifSC-Regular|NotoSerifSC-Bold|NotoSansSC-Bold)$/.test(
                base.decodeText(),
              )
            )
              return { ok: false, reason: "rejected" };
          }
        }
      if (!count) return { ok: false, reason: "rejected" };
      return signal.aborted
        ? { ok: false, reason: "aborted" }
        : { ok: true, value: { pdf: new Uint8Array(pdf) } };
    } catch {
      return { ok: false, reason: signal.aborted ? "aborted" : "unavailable" };
    }
  }
  return {
    configured,
    render(input) {
      if (closed) return Promise.resolve({ ok: false, reason: "closed" });
      const work = run(input);
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    close() {
      if (closing) return closing;
      closed = true;
      stopping.abort();
      closing = Promise.allSettled([...pending]).then(() => undefined);
      return closing;
    },
  };
}
