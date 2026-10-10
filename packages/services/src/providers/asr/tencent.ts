import { failed, ok } from "../types.js";
import type { AsrProvider } from "../types.js";
import { asrFailure, createAsrHttp } from "./http.js";
import type { TencentAsrConfig, TencentAsrOptions } from "./http.js";
import {
  errorCode,
  parseTask,
  record,
  rejectedBeforeAcceptance,
  requestId,
  taskId,
} from "./parse.js";

export type { TencentAsrConfig, TencentAsrOptions } from "./http.js";

function validUrl(value: string): boolean {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** 仅提供构造出口。生产选择、受理归属、预算与后续轮询由 W315 的拥有者接入。 */
export function createTencentAsr(
  config: TencentAsrConfig,
  options: TencentAsrOptions,
): {
  provider: AsrProvider;
  close: () => Promise<void>;
} {
  const http = createAsrHttp(config, options);
  const provider: AsrProvider = {
    status: "tencent",
    configured: true,
    transcribe: () => Promise.resolve(failed("unsupported", "异步录音转写不支持同步结果")),
    async submit(input) {
      if (!validUrl(input.url))
        return asrFailure("rejected", "录音转写输入不合法", "not_accepted", "invalid_input");
      const result = await http.request(
        "CreateRecTask",
        JSON.stringify({
          EngineModelType: "16k_zh",
          ChannelNum: 1,
          ResTextFormat: 3,
          SourceType: 0,
          Url: input.url,
        }),
        input.signal,
      );
      if (!result.ok) return result;
      const response = result.value;
      const request = requestId(response);
      const code = errorCode(response);
      if (request && code)
        return rejectedBeforeAcceptance(code)
          ? asrFailure("rejected", "录音转写提交被拒绝", "not_accepted", "provider_rejected")
          : asrFailure("unavailable", "录音转写提交结果未知", "unknown", "unknown_outcome");
      const id = taskId(record(response.Data)?.TaskId);
      if (!request || !id || Object.hasOwn(response, "Error"))
        return asrFailure("unavailable", "录音转写响应不完整", "unknown", "invalid_response");
      return ok({ taskId: id, requestId: request });
    },
    async query(input) {
      if (typeof input.taskId !== "string") return failed("rejected", "录音转写任务号不合法");
      const id = taskId(input.taskId);
      if (!id) return failed("rejected", "录音转写任务号不合法");
      // id 已严格验证为 uint64 十进制；直接写数字 token，绝不转 Number。
      const result = await http.request("DescribeTaskStatus", `{"TaskId":${id}}`, input.signal);
      if (!result.ok) return failed(result.reason, result.message);
      const code = errorCode(result.value);
      if (requestId(result.value) && code)
        return rejectedBeforeAcceptance(code) || code === "FailedOperation.NoSuchTask"
          ? failed("rejected", "录音转写查询被拒绝")
          : failed("unavailable", "录音转写查询失败");
      const value = Object.hasOwn(result.value, "Error") ? undefined : parseTask(result.value, id);
      return value ? ok(value) : failed("unavailable", "录音转写响应不完整");
    },
  };
  return { provider, close: () => http.close() };
}
