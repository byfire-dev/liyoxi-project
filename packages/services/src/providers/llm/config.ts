export interface LlmEndpoint {
  vendor: "ark" | "bailian" | "deepseek";
  model: string;
  apiKey: string;
  /** 百炼北京业务空间；不能传任意 URL、地区或路径。 */
  workspaceId?: string;
}

export interface DomesticLlmConfig {
  text: { primary: LlmEndpoint; backup: LlmEndpoint };
  vision: { primary: LlmEndpoint; backup: LlmEndpoint };
}

export interface DomesticLlmOptions {
  /** 协议测试可将固定目的地转发 loopback；生产缺省使用原生 fetch。 */
  fetch?: typeof fetch;
  /** 仅可缩短；单请求硬上限30s，整次调用硬上限60s。 */
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

export const LLM_LIMITS = {
  responseBytes: 1024 * 1024,
  textBytes: 64 * 1024,
  urlBytes: 8 * 1024,
  descriptionChars: 2000,
  tags: 20,
  tagChars: 100,
  points: 20,
  pointChars: 500,
  requests: 3,
} as const;

export function endpointUrl(endpoint: LlmEndpoint): string {
  if (
    !endpoint ||
    typeof endpoint.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(endpoint.model) ||
    typeof endpoint.apiKey !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(endpoint.apiKey)
  )
    throw new TypeError("素材理解配置不合法");
  if (endpoint.vendor === "bailian") {
    if (
      typeof endpoint.workspaceId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(endpoint.workspaceId)
    )
      throw new TypeError("素材理解配置不合法");
    return `https://${endpoint.workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
  }
  if (endpoint.workspaceId !== undefined) throw new TypeError("素材理解配置不合法");
  if (endpoint.vendor === "ark") return "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
  if (endpoint.vendor === "deepseek") return "https://api.deepseek.com/chat/completions";
  throw new TypeError("素材理解配置不合法");
}

export function deadlines(options: DomesticLlmOptions): { request: number; total: number } {
  const request = options.timeoutMs ?? 30000;
  const total = options.totalTimeoutMs ?? 60000;
  if (
    !Number.isSafeInteger(request) ||
    request < 1 ||
    request > 30000 ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > 60000
  )
    throw new TypeError("素材理解期限不合法");
  return { request, total };
}
