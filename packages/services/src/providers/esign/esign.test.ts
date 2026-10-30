import { createElement } from "react";
import { Document, Image, Page, renderToBuffer, Text } from "@react-pdf/renderer";
import { SignPdf } from "@signpdf/signpdf";
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import QRCode from "qrcode";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createPlatformCertSigner } from "./platform-cert.js";
import type { PlatformCertOptions, PlatformCertResult } from "./platform-cert.js";
import type { P12Material } from "./material.js";
import {
  createTestMaterial,
  TEST_PASSPHRASE,
  unsupportedEcP12,
  verifyTestPdf,
} from "./__fixtures__/test-material.js";

const NOW = new Date("2026-10-30T03:00:00.789Z");
const SERIALIZED_NOW = new Date("2026-10-30T03:00:00Z");
let fixture: ReturnType<typeof createTestMaterial>;
let pdf: Buffer;

beforeAll(async () => {
  fixture = createTestMaterial();
  const png = await QRCode.toBuffer("https://example.invalid/v/TEST-ONLY", { type: "png" });
  pdf = await renderToBuffer(
    createElement(
      Document,
      { title: "TEST ONLY signing dependency probe" },
      createElement(
        Page,
        { size: "A4" },
        createElement(Text, null, "TEST ONLY - no production certificate or legal effect"),
        createElement(Image, {
          src: { data: png, format: "png" },
          style: { width: 64, height: 64 },
        }),
      ),
    ),
  );
});

function signer(overrides: Partial<PlatformCertOptions> = {}) {
  return createPlatformCertSigner({
    clock: { now: () => new Date(NOW) },
    loadMaterial: async () => fixture.material,
    ...overrides,
  });
}
function success(result: PlatformCertResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("标准 RSA-P12 factory 的真实签名字节（TEST ONLY）", () => {
  it("真实renderer/QR PDF经签署可由Node独立核验；issuer/serial/time来自实际leaf", async () => {
    const driver = signer();
    const signed = success(await driver.seal({ pdf }));
    const verified = verifyTestPdf(signed.pdf, fixture.leaf, fixture.root);
    expect(signed).toMatchObject({
      mode: "certificate",
      driver: "platform_cert",
      certIssuer: fixture.leaf.issuer,
      certSerial: fixture.leaf.serialNumber,
    });
    expect(signed.certSerial).not.toBe(fixture.root.serialNumber);
    expect(signed.signedAt).toEqual(SERIALIZED_NOW);
    expect(verified.signedAt).toEqual(signed.signedAt);
    const parsed = await PDFDocument.load(signed.pdf, { updateMetadata: false });
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getTitle()).toBe("TEST ONLY signing dependency probe");
    expect(parsed.getForm().getFields()).toHaveLength(1);
    const signature = parsed
      .getForm()
      .getFields()[0]!
      .acroField.dict.lookup(PDFName.of("V"), PDFDict);
    expect(signature.lookup(PDFName.of("M"), PDFString).asString()).toBe("D:20261030030000Z");
    await driver.close();
  });

  it("正文任一覆盖字节篡改或追加未签内容均不能通过；不是只检查mode", async () => {
    const driver = signer();
    const signed = success(await driver.seal({ pdf }));
    const original = Buffer.from(signed.pdf);
    const stream = original.indexOf(Buffer.from("stream\n"));
    expect(stream).toBeGreaterThan(0);
    for (let offset = 0; offset < 8; offset += 1) {
      const changed = Buffer.from(original);
      changed[stream + 7 + offset]! ^= 1;
      expect(() => verifyTestPdf(changed, fixture.leaf, fixture.root)).toThrow();
    }
    const { byteRange } = verifyTestPdf(original, fixture.leaf, fixture.root);
    const begin = byteRange[1]!;
    const end = byteRange[2]!;
    const raw = Buffer.from(original.subarray(begin + 1, end - 1).toString("ascii"), "hex");
    const octets = raw[1]! < 0x80 ? 0 : raw[1]! & 0x7f;
    const cmsEnd = octets === 0 ? 2 + raw[1]! : 2 + octets + raw.readUIntBE(2, octets);
    raw[cmsEnd - 1]! ^= 1; // 改真正RSA签名字节，正文摘要不变，独立verify仍须拒绝。
    const badSignature = Buffer.from(original);
    badSignature.write(raw.toString("hex"), begin + 1, "ascii");
    expect(() => verifyTestPdf(badSignature, fixture.leaf, fixture.root)).toThrow();
    expect(() =>
      verifyTestPdf(
        Buffer.concat([original, Buffer.from("\n% unsigned tail")]),
        fixture.leaf,
        fixture.root,
      ),
    ).toThrow("unsigned trailing data");
    await driver.close();
  });

  it("同实例并发与两实例并发签署彼此隔离，最终字节均独立核验", async () => {
    const first = signer();
    const second = signer({ clock: { now: () => new Date("2026-10-30T03:01:00Z") } });
    const values = (
      await Promise.all([first.seal({ pdf }), first.seal({ pdf }), second.seal({ pdf })])
    ).map(success);
    const times = values.map((value) =>
      verifyTestPdf(value.pdf, fixture.leaf, fixture.root).signedAt.toISOString(),
    );
    expect(times).toEqual([
      SERIALIZED_NOW.toISOString(),
      SERIALIZED_NOW.toISOString(),
      "2026-10-30T03:01:00.000Z",
    ]);
    await first.close();
    expect(success(await second.seal({ pdf })).signedAt.toISOString()).toBe(
      "2026-10-30T03:01:00.000Z",
    );
    await second.close();
  });

  it.each([
    ["未配置", (): null => null, "unconfigured"],
    ["错误口令", () => ({ ...fixture.material, passphrase: "TEST ONLY WRONG SECRET" }), "rejected"],
    ["畸形P12", () => ({ p12: Buffer.from("not a p12"), passphrase: TEST_PASSPHRASE }), "rejected"],
    ["错私钥/leaf", () => fixture.mismatched(), "rejected"],
    ["不完整链", () => fixture.missingChain(), "rejected"],
    ["真实EC PKCS8材料", () => unsupportedEcP12(), "rejected"],
  ] as const)("%s受控失败且不返回stamp或证书假事实", async (_name, material, reason) => {
    const driver = signer({ loadMaterial: async () => material() });
    const result = await driver.seal({ pdf });
    expect(result).toEqual({ ok: false, reason, message: `机构证书签署未成功：${reason}` });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    await driver.close();
  });

  it.each(["2025-10-30T03:00:00Z", "2028-10-30T03:00:00Z", "invalid"])(
    "无效签署时间/证书有效期拒绝：%s",
    async (now) => {
      const driver = signer({ clock: { now: () => new Date(now) } });
      expect(await driver.seal({ pdf })).toMatchObject({ ok: false, reason: "rejected" });
      await driver.close();
    },
  );

  it("占位不足、畸形PDF和重复签名拒绝，不截断也不修改已签字节", async () => {
    const short = signer({ signatureLength: 16 });
    expect(await short.seal({ pdf })).toMatchObject({ ok: false, reason: "rejected" });
    const driver = signer();
    expect(await driver.seal({ pdf: Buffer.from("not a PDF") })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    const signed = success(await driver.seal({ pdf }));
    expect(await driver.seal({ pdf: signed.pdf })).toMatchObject({ ok: false, reason: "rejected" });
    verifyTestPdf(signed.pdf, fixture.leaf, fixture.root);
    await Promise.all([short.close(), driver.close()]);
  });

  it("材料端口失败不泄漏异常内容", async () => {
    const driver = signer({
      loadMaterial: async () => {
        throw new Error("TEST ONLY secret material contents");
      },
    });
    expect(await driver.seal({ pdf })).toEqual({
      ok: false,
      reason: "unavailable",
      message: "机构证书签署未成功：unavailable",
    });
    await driver.close();
  });
});

describe("取消与关闭等待真实在途，不伪称可以抢占同步签名", () => {
  it("预取消不调用材料端口", async () => {
    const loadMaterial = vi.fn(async () => fixture.material);
    const controller = new AbortController();
    controller.abort();
    const driver = signer({ loadMaterial });
    expect(await driver.seal({ pdf, signal: controller.signal })).toMatchObject({
      ok: false,
      reason: "aborted",
    });
    expect(loadMaterial).not.toHaveBeenCalled();
    await driver.close();
  });

  it("close幂等、拒新、传signal，并等待忽略取消的材料端口真正结束", async () => {
    const gate = deferred<P12Material | null>();
    const entered = deferred<AbortSignal>();
    const driver = signer({
      loadMaterial: async ({ signal }) => {
        entered.resolve(signal);
        return gate.promise;
      },
    });
    const active = driver.seal({ pdf });
    const signal = await entered.promise;
    const close = driver.close();
    expect(driver.close()).toBe(close);
    expect(signal.aborted).toBe(true);
    expect(await driver.seal({ pdf })).toMatchObject({ ok: false, reason: "closed" });
    let finished = false;
    void close.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    gate.resolve(fixture.material);
    expect(await active).toMatchObject({ ok: false, reason: "aborted" });
    await close;
    expect(finished).toBe(true);
  });

  it("真实同步签名结束时取消会丢弃结果；不返回成功字节", async () => {
    const controller = new AbortController();
    const original = SignPdf.prototype.sign;
    const intercept = vi.spyOn(SignPdf.prototype, "sign").mockImplementation(async function (
      this: SignPdf,
      input,
      key,
      time,
    ) {
      const bytes = await original.call(this, input, key, time); // 仍执行真实签名
      controller.abort();
      return bytes;
    });
    const driver = signer();
    try {
      expect(await driver.seal({ pdf, signal: controller.signal })).toMatchObject({
        ok: false,
        reason: "aborted",
      });
      expect(intercept).toHaveBeenCalledOnce();
    } finally {
      intercept.mockRestore();
      await driver.close();
    }
  });
});
