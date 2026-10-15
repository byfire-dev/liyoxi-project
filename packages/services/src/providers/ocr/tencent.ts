import { ocr } from "tencentcloud-sdk-nodejs-ocr";
import type { ClientConfig } from "tencentcloud-sdk-nodejs-common";
import { z } from "zod";
import { failed, ok } from "../types.js";
import type { OcrProvider, ProviderResult } from "../types.js";
import { OCR_HOST, OcrAgent } from "./agent.js";
import { parseBusinessLicense } from "./parse.js";
import { parseBankReceipt } from "./receipt.js";

const configSchema = z
  .object({
    secretId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    secretKey: z.string().min(1).max(256),
    region: z.string().regex(/^ap-[a-z]+(?:-[a-z]+)*$/),
  })
  .strict();
export type TencentOcrConfig = z.infer<typeof configSchema>;
type SdkClient = Pick<InstanceType<typeof ocr.v20181119.Client>, "request">;
export interface TencentOcrOptions {
  /** 只可缩短六秒硬上限；组合根不开放配置。 */
  timeoutMs?: number;
  /** 私有协议测试使用真实 SDK 转发 loopback；生产组合根不注入。 */
  createClient?: (config: ClientConfig) => SdkClient;
}

function isImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

/** 固定营业执照/银行回单 API；构造零IO，不接行业许可证或默认重试。 */
export function createTencentOcr(
  config: TencentOcrConfig,
  options: TencentOcrOptions = {},
): {
  provider: OcrProvider;
  close(): Promise<void>;
} {
  const parsed = configSchema.safeParse(config);
  const timeoutMs = options.timeoutMs ?? 6000;
  if (!parsed.success || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6000)
    throw new TypeError("证照识别配置不合法");
  const agent = new OcrAgent();
  const clientConfig: ClientConfig = {
    credential: { secretId: parsed.data.secretId, secretKey: parsed.data.secretKey },
    region: parsed.data.region,
    profile: {
      signMethod: "TC3-HMAC-SHA256",
      httpProfile: {
        endpoint: OCR_HOST,
        protocol: "https://",
        reqMethod: "POST",
        reqTimeout: 6,
        agent,
      },
    },
  };
  let client: SdkClient;
  try {
    client = options.createClient?.(clientConfig) ?? new ocr.v20181119.Client(clientConfig);
  } catch {
    agent.destroy();
    throw new TypeError("证照识别驱动构造失败");
  }
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  function recognize<T>(
    input: { imageUrl: string; signal?: AbortSignal },
    action: "BizLicenseOCR" | "BankSlipOCR",
    parse: (raw: unknown) => T | undefined,
  ): Promise<ProviderResult<T>> {
    if (closed) return Promise.resolve(failed("unavailable", "证照识别驱动已关闭"));
    if (!isImageUrl(input.imageUrl))
      return Promise.resolve(failed("rejected", "证照图片地址不合法"));
    if (input.signal?.aborted) return Promise.resolve(failed("rejected", "证照识别调用已取消"));
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const work = (async (): Promise<ProviderResult<T>> => {
      try {
        if (controller.signal.aborted) return failed("rejected", "证照识别调用已取消");
        // generated BizLicenseOCR 不收 RequestOptions；SDK 公开 request 原样传递 signal 并签名。
        const raw: unknown = await client.request(
          action,
          action === "BankSlipOCR"
            ? { ImageUrl: input.imageUrl, IsPdf: true, PdfPageNumber: 1 }
            : {
                ImageUrl: input.imageUrl,
                EnableCopyWarn: true,
                EnablePeriodComplete: true,
                EnableBusinessCertificate: false,
              },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return failed("unavailable", "证照识别调用未完成");
        const fields = parse(raw);
        return fields ? ok(fields) : failed("rejected", "证照识别结果不可识别");
      } catch (error) {
        // SDK 异常可能夹带请求 URL、响应正文和凭据；任何路径都不输出/记录原异常。
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          [
            "FailedOperation.ImageDecodeFailed",
            "FailedOperation.NoBizLicense",
            "FailedOperation.OcrFailed",
            "LimitExceeded.TooLargeFileError",
            "InvalidParameterValue.InvalidParameterValueLimit",
          ].includes(typeof error.code === "string" ? error.code : "")
        )
          return failed("rejected", "证照识别结果不可识别");
        return failed("unavailable", timedOut ? "证照识别调用超时" : "证照识别服务暂不可用");
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        controllers.delete(controller);
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work));
    return work;
  }
  const provider: OcrProvider = {
    status: "tencent",
    configured: true,
    extractLicenseFields: () => Promise.resolve(failed("unsupported", "行业许可证识别暂未接入")),
    recognizeBusinessLicense: (input) => recognize(input, "BizLicenseOCR", parseBusinessLicense),
    recognizeBankReceipt: (input) =>
      recognize({ imageUrl: input.fileUrl, signal: input.signal }, "BankSlipOCR", parseBankReceipt),
  };
  return {
    provider,
    close() {
      if (closing) return closing;
      closed = true;
      for (const controller of controllers) controller.abort();
      agent.destroy();
      closing = Promise.allSettled([...pending]).then(() => undefined);
      return closing;
    },
  };
}
