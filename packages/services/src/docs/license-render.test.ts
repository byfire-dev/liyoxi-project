import { resolve } from "node:path";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { licenseContentFingerprint } from "./license-convergence.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";
import { createLicensePdfRenderer } from "./license-render.js";
import {
  createTestLicenseTemplateCatalog,
  createTestPlatformCertEsign,
  createTestMaterial,
  verifyTestPdf,
} from "../testing/index.js";

const fontDir = resolve(import.meta.dirname, "../../../../infra/docker/server/fonts");
const fixture = () =>
  parseLicenseLetterSnapshot({
    licensor: { name: "测试授权有限公司", creditCode: "91000000FAKE000001" },
    licensee: {
      name: "龘䶮㙟测试被授权有限公司",
      creditCode: "91000000FAKE000002",
      store: "测试门店",
    },
    drama: {
      name: "技术联调剧目",
      episodes: 12,
      permits: [{ kind: "发行许可证", number: "测试字第123号", platform: "douyin" }],
    },
    account: { platform: "douyin", name: "测试账号", accountId: "TEST-ONLY-123" },
    period: { start: null, startText: "自上线首日起", end: "2027-10-30", territory: "中国大陆" },
    rightsClauseKey: "v1.rights",
    exclusiveClauseKey: "v1.exclusive",
    obligationClauseKey: "v1.offline",
    consent: { consentNo: "123", agreement: "测试协议", at: "2026-10-30T03:00:00Z", by: "测试人" },
    orderNo: "TLYX2026103000001",
    letterNo: "TSQ2026103000001-1-DY",
    revNo: 1,
    issuedAt: "2026-10-30T03:00:00Z",
    verifyUrl: "https://example.invalid/v?code=0123456789ABCDEF&rev=1",
  });
async function read(pdf: Uint8Array) {
  await import("@napi-rs/canvas");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(pdf),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    stopAtErrors: true,
  });
  try {
    const doc = await loading.promise;
    const pages: string[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent({ disableNormalization: true });
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join("")
          .replaceAll("\u00a0", " "),
      );
      page.cleanup();
    }
    return pages;
  } finally {
    await loading.destroy();
  }
}
const request = (snapshot = fixture()) => ({
  snapshot,
  templateVersion: "v1",
  contentFingerprint: licenseContentFingerprint(snapshot),
});

describe("不可变授权快照真实PDF", () => {
  it("正式v1缺法务正文时未配置，不能使用历史占位条款出件", async () => {
    const renderer = createLicensePdfRenderer({ fontDir });
    expect(renderer.configured).toBe(false);
    expect(await renderer.render(request())).toEqual({ ok: false, reason: "unconfigured" });
    await renderer.close();
  });
  it("三固定字体、长文本分页、每页页脚/指纹/技术标记、真实QR及数字签名字节", async () => {
    const catalog = structuredClone(createTestLicenseTemplateCatalog());
    const repeated = "技术联调长文本仅供测试，禁止将本样张用于真实授权。";
    const extended = {
      ...catalog,
      v1: {
        ...catalog.v1!,
        clauses: catalog.v1!.clauses.map((clause, index) =>
          index === 0
            ? { ...clause, paragraphs: Array.from({ length: 24 }, () => repeated.repeat(5)) }
            : clause,
        ),
      },
    };
    const renderer = createLicensePdfRenderer({ fontDir, catalog: extended });
    const input = request();
    input.snapshot.licensee.store = "测试\r\n门店\t名称\u0000";
    input.contentFingerprint = licenseContentFingerprint(input.snapshot);
    const original = JSON.stringify(input.snapshot);
    const result = await renderer.render(input);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(input.snapshot)).toBe(original);
    const pages = await read(result.value.pdf);
    expect(pages.length).toBeGreaterThan(1);
    for (const [index, page] of pages.entries()) {
      expect(page).toContain("技术联调样张，非法务定稿");
      expect(page).toContain(input.snapshot.letterNo);
      expect(page).toContain(`第 ${index + 1} 页 / 共 ${pages.length} 页`);
      expect(page.replaceAll(" ", "")).toContain(input.contentFingerprint);
    }
    expect(pages.join("")).toContain("龘䶮㙟");
    const doc = await PDFDocument.load(result.value.pdf);
    const names = new Set<string>();
    let images = 0;
    for (const [, object] of doc.context.enumerateIndirectObjects())
      if (object instanceof PDFDict) {
        const font = object.get(PDFName.of("BaseFont"));
        if (font instanceof PDFName) names.add(font.decodeText().replace(/^[A-Z]{6}\+/, ""));
        if (object.get(PDFName.of("Subtype")) === PDFName.of("Image")) images++;
      }
    // Image streams expose a dictionary through .dict, checked separately below.
    for (const [, object] of doc.context.enumerateIndirectObjects())
      if (
        "dict" in object &&
        object.dict instanceof PDFDict &&
        object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")
      )
        images++;
    expect(names).toEqual(new Set(["NotoSerifSC-Regular", "NotoSerifSC-Bold", "NotoSansSC-Bold"]));
    expect(images).toBeGreaterThan(0);
    const material = createTestMaterial();
    const signer = createTestPlatformCertEsign({
      clock: { now: () => new Date("2026-10-30T03:00:00Z") },
      loadMaterial: async () => material.material,
    });
    const signed = await signer.provider.seal({ pdf: result.value.pdf });
    expect(signed.ok).toBe(true);
    if (signed.ok) verifyTestPdf(signed.value.pdf, material.leaf, material.root);
    await signer.close();
    await renderer.close();
  }, 30000);
  it("精确缺标量码点与字段、去重有界；同一快照不替字或改写", async () => {
    const renderer = createLicensePdfRenderer({
      fontDir,
      catalog: createTestLicenseTemplateCatalog(),
    });
    const value = fixture();
    value.licensee.name = "𠮷😀𠮷";
    value.account.name = "😀";
    const before = JSON.stringify(value);
    const result = await renderer.render(request(value));
    expect(result).toMatchObject({
      ok: false,
      reason: "missing_glyph",
      issue: {
        kind: "missing_glyph",
        totalMissingCodePoints: 2,
        truncated: false,
        missing: [
          { character: "𠮷", codePoint: "U+20BB7", fields: ["licensee.name"] },
          { character: "😀", codePoint: "U+1F600", fields: ["licensee.name", "account.name"] },
        ],
      },
    });
    expect(JSON.stringify(value)).toBe(before);
    value.licensee.name = Array.from({ length: 60 }, (_, index) =>
      String.fromCodePoint(0x1f600 + index),
    ).join("");
    const bounded = await renderer.render(request(value));
    expect(bounded).toMatchObject({ reason: "missing_glyph", issue: { truncated: true } });
    if (!bounded.ok && bounded.reason === "missing_glyph") {
      expect(bounded.issue.missing).toHaveLength(32);
      expect(Buffer.byteLength(JSON.stringify(bounded.issue))).toBeLessThan(8192);
    }
    await renderer.close();
  });
  it("孤立代理受控拒绝；组合/变体序列不静默丢字；缺失字体不回退；close拒新", async () => {
    const renderer = createLicensePdfRenderer({
      fontDir,
      catalog: createTestLicenseTemplateCatalog(),
    });
    const broken = fixture();
    broken.licensee.name = "非法\ud800";
    expect(await renderer.render(request(broken))).toMatchObject({ ok: false, reason: "rejected" });
    const combining = fixture();
    combining.licensee.name = "e\u0301";
    const composed = await renderer.render(request(combining));
    expect(composed.ok).toBe(true);
    if (composed.ok) expect((await read(composed.value.pdf)).join("")).toContain("e\u0301");
    for (const name of ["字\ufe0f", "字\u200d字"]) {
      const sample = fixture();
      sample.licensee.name = name;
      const result = await renderer.render(request(sample));
      // Sequences are accepted only if every scalar has an actual glyph; never skip selectors/joiners.
      expect(result.ok).toBe(false);
    }
    const missing = createLicensePdfRenderer({
      fontDir: "/does-not-exist",
      catalog: createTestLicenseTemplateCatalog(),
    });
    expect(await missing.render(request())).toEqual({ ok: false, reason: "unavailable" });
    await missing.close();
    await renderer.close();
    expect(await renderer.render(request())).toEqual({ ok: false, reason: "closed" });
  });
});
