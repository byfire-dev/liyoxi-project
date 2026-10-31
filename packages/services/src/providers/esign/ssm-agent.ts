import { Agent } from "node:https";
import type { ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";
import type { Duplex } from "node:stream";

export const SSM_HOST = "ssm.tencentcloudapi.com";
export function guardSsmRequest(request: ClientRequest): void {
  request.setHeader("Accept-Encoding", "identity");
  request.prependOnceListener("response", (response) => {
    const reject = () => {
      request.emit("error", new Error("签署材料响应不可接受"));
      response.destroy();
    };
    if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
      reject();
      return;
    }
    const encoding = response.headers["content-encoding"];
    if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
      reject();
      return;
    }
    let bytes = 0;
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262144) reject();
    });
  });
}
export class SsmAgent extends Agent {
  constructor() {
    super({ keepAlive: false, maxSockets: 2 });
  }
  addRequest(request: ClientRequest, options: RequestOptions): void {
    guardSsmRequest(request);
    const addRequest: unknown = Reflect.get(Agent.prototype, "addRequest");
    if (typeof addRequest !== "function") throw new Error("签署材料传输不可用");
    Reflect.apply(addRequest, this, [request, options]);
  }
  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (
      options.host !== SSM_HOST ||
      (options.port !== undefined && String(options.port) !== "443") ||
      (options.servername !== undefined && options.servername !== SSM_HOST)
    )
      throw new Error("签署材料请求目标不合法");
    return super.createConnection(options, callback);
  }
}
