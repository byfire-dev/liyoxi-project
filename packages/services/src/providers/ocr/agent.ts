import { Agent } from "node:https";
import type { ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";
import type { Duplex } from "node:stream";

export const OCR_HOST = "ocr.tencentcloudapi.com";

/** 在 node-fetch 的 response 监听之前安装；编码响应不进入解压/JSON解析。 */
export function guardOcrRequest(request: ClientRequest): void {
  request.setHeader("Accept-Encoding", "identity");
  request.prependOnceListener("response", (response) => {
    const reject = (message: string) => {
      // 同步 error 让 SDK fetch 立即拒绝，已开始读正文时也销毁它持有的流。
      request.emit("error", new Error(message));
      response.destroy();
    };
    const encoding = response.headers["content-encoding"];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
      reject("证照识别不接受编码响应");
      return;
    }
    let bytes = 0;
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) reject("证照识别响应过大");
    });
  });
}

/** SDK 自带 fetch 会跟随重定向；专用 Agent 禁止换目标，也不消费环境代理。 */
export class OcrAgent extends Agent {
  constructor() {
    super({ keepAlive: false, maxSockets: 8 });
  }

  // Node Agent 的真实请求挂载点；Node24运行时公开存在，@types/node未声明此方法。
  addRequest(request: ClientRequest, options: RequestOptions): void {
    guardOcrRequest(request);
    const addRequest: unknown = Reflect.get(Agent.prototype, "addRequest");
    if (typeof addRequest !== "function") throw new Error("证照识别传输不可用");
    Reflect.apply(addRequest, this, [request, options]);
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
    return stream;
  }
}
