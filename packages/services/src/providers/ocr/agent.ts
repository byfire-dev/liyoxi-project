import { Agent } from "node:https";
import type { RequestOptions } from "node:https";
import type { Duplex } from "node:stream";

export const OCR_HOST = "ocr.tencentcloudapi.com";

/** SDK 自带 fetch 会跟随重定向；专用 Agent 禁止换目标，也不消费环境代理。 */
export class OcrAgent extends Agent {
  constructor() {
    super({ keepAlive: false, maxSockets: 8 });
  }

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (
      options.host !== OCR_HOST ||
      (options.port !== undefined && String(options.port) !== "443") ||
      (options.servername !== undefined && options.servername !== OCR_HOST)
    )
      throw new Error("证照识别请求目标不合法");
    const stream = super.createConnection(options, callback);
    // 每个连接只服务一个请求；限制 SDK JSON 解码前的真实响应字节（含 HTTP 头）。
    let bytes = 0;
    stream?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stream.destroy(new Error("证照识别响应过大"));
    });
    return stream;
  }
}
