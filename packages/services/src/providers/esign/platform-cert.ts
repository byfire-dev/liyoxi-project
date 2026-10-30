import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { P12Signer } from "@signpdf/signer-p12";
import { SignPdf } from "@signpdf/signpdf";
import { PDFDocument, PDFSignature } from "pdf-lib";

import { inspectP12 } from "./material.js";
import type { P12Material } from "./material.js";

export type PlatformCertResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly pdf: Uint8Array;
        readonly mode: "certificate";
        readonly driver: "platform_cert";
        readonly certIssuer: string;
        readonly certSerial: string;
        readonly signedAt: Date;
      };
    }
  | {
      readonly ok: false;
      readonly reason: "unconfigured" | "unavailable" | "rejected" | "aborted" | "closed";
      readonly message: string;
    };

export interface PlatformCertOptions {
  readonly clock: { now(): Date };
  /** 只能由未来 worker 装配提供；null 表示未配置，不读环境/文件，也不降为 stamp。 */
  readonly loadMaterial: (input: { readonly signal: AbortSignal }) => Promise<P12Material | null>;
  readonly signatureLength?: number;
}

export function createPlatformCertSigner(options: PlatformCertOptions) {
  const signatureLength = options.signatureLength ?? 16384;
  if (!Number.isSafeInteger(signatureLength) || signatureLength < 16 || signatureLength > 65536) {
    throw new RangeError("签名占位长度不合法");
  }
  const stopping = new AbortController();
  const pending = new Set<Promise<PlatformCertResult>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const failure = (
    reason: "unconfigured" | "unavailable" | "rejected" | "aborted" | "closed",
  ): PlatformCertResult => ({
    ok: false,
    reason,
    message: `机构证书签署未成功：${reason}`,
  });

  async function run(input: {
    pdf: Uint8Array;
    signal?: AbortSignal;
  }): Promise<PlatformCertResult> {
    const signal = input.signal
      ? AbortSignal.any([stopping.signal, input.signal])
      : stopping.signal;
    if (signal.aborted) return failure("aborted");
    if (
      !(input.pdf instanceof Uint8Array) ||
      input.pdf.byteLength === 0 ||
      input.pdf.byteLength > 16_777_216
    ) {
      return failure("rejected");
    }
    const pdf = Buffer.from(input.pdf);
    let stage: "material" | "signing" = "material";
    let privateCopy: Buffer | undefined;
    try {
      const loaded = await options.loadMaterial({ signal });
      if (signal.aborted) return failure("aborted");
      if (loaded === null) return failure("unconfigured");
      stage = "signing";
      // 不保留调用方可变 Buffer；私有副本在本次调用结束后覆盖。
      if (!(loaded.p12 instanceof Uint8Array) || loaded.p12.byteLength > 1_048_576) {
        return failure("rejected");
      }
      privateCopy = Buffer.from(loaded.p12);
      const material = { p12: privateCopy, passphrase: loaded.passphrase };
      const instant = options.clock.now().getTime();
      if (!Number.isFinite(instant)) return failure("rejected");
      // PDF/CMS 的签署时间精度为秒，返回与实际签名字节相同的时间。
      const signedAt = new Date(Math.floor(instant / 1000) * 1000);
      const leaf = inspectP12(material, signedAt);
      const document = await PDFDocument.load(pdf, { updateMetadata: false });
      if (signal.aborted) return failure("aborted");
      if (
        document
          .getForm()
          .getFields()
          .some((field) => field instanceof PDFSignature)
      ) {
        return failure("rejected");
      }
      pdflibAddPlaceholder({
        pdfDoc: document,
        reason: "Platform document signature",
        contactInfo: "",
        name: leaf.subject,
        location: "",
        signingTime: signedAt,
        signatureLength,
        subFilter: "adbe.pkcs7.detached",
        appName: "liyoxi",
      });
      const prepared = await document.save({
        useObjectStreams: false,
        updateFieldAppearances: false,
      });
      if (signal.aborted) return failure("aborted");
      // 两个对象均按调用新建，不共享默认 singleton 的 lastSignature 或可变 P12 缓冲。
      const signer = new P12Signer(privateCopy, {
        passphrase: material.passphrase,
        asn1StrictParsing: true,
      });
      const signed = await new SignPdf().sign(prepared, signer, signedAt);
      // 同步 CPU 签名不可被 signal 抢占；返回后检查并丢弃已取消结果。
      if (signal.aborted) return failure("aborted");
      return {
        ok: true,
        value: {
          pdf: new Uint8Array(signed),
          mode: "certificate",
          driver: "platform_cert",
          certIssuer: leaf.issuer,
          certSerial: leaf.serialNumber,
          signedAt,
        },
      };
    } catch {
      // 不回传库异常：可能含口令、证书或文书内容。
      return failure(
        signal.aborted ? "aborted" : stage === "material" ? "unavailable" : "rejected",
      );
    } finally {
      privateCopy?.fill(0);
    }
  }

  return {
    seal(input: { pdf: Uint8Array; signal?: AbortSignal }): Promise<PlatformCertResult> {
      if (closed) return Promise.resolve(failure("closed"));
      const work = run(input);
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      stopping.abort();
      closing = Promise.allSettled([...pending]).then(() => undefined);
      return closing;
    },
  };
}
