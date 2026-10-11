import { failed, ok } from "../types.js";
import type { LlmProvider, ProviderResult } from "../types.js";
import { deadlines, endpointUrl, LLM_LIMITS } from "./config.js";
import type { DomesticLlmConfig, DomesticLlmOptions, LlmEndpoint } from "./config.js";
import { requestChat } from "./http.js";
import { chatContent, pointOutput, tagOutput } from "./parse.js";
import { DIGEST_JSON_INSTRUCTIONS, prepareDigest } from "./digest.js";

export type { DomesticLlmConfig, DomesticLlmOptions, LlmEndpoint } from "./config.js";

function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= LLM_LIMITS.textBytes
  );
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > LLM_LIMITS.urlBytes)
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function copyEndpoint(endpoint: LlmEndpoint): LlmEndpoint {
  endpointUrl(endpoint);
  return {
    vendor: endpoint.vendor,
    model: endpoint.model,
    apiKey: endpoint.apiKey,
    ...(endpoint.workspaceId === undefined ? {} : { workspaceId: endpoint.workspaceId }),
  };
}

type UserContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

/** 显式协议构造；默认工厂不启用。装配拥有者仍须包上原外呼守卫并登记 close。 */
export function createDomesticLlm(
  config: DomesticLlmConfig,
  options: DomesticLlmOptions = {},
): {
  provider: LlmProvider;
  close: () => Promise<void>;
} {
  const limits = deadlines(options);
  const routes = {
    text: { primary: copyEndpoint(config.text.primary), backup: copyEndpoint(config.text.backup) },
    vision: {
      primary: copyEndpoint(config.vision.primary),
      backup: copyEndpoint(config.vision.backup),
    },
  };
  const transport = options.fetch ?? fetch;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function run<T>(
    role: "text" | "vision",
    content: UserContent,
    schema: string,
    parse: (value: unknown) => T | undefined,
    signal?: AbortSignal,
  ): Promise<ProviderResult<T>> {
    if (closed) return Promise.resolve(failed("unavailable", "素材理解驱动已关闭"));
    if (signal?.aborted) return Promise.resolve(failed("unavailable", "素材理解调用已取消"));
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, limits.total);
    const work = (async (): Promise<ProviderResult<T>> => {
      let endpoint = routes[role].primary;
      let usedBackup = false;
      let usedRepair = false;
      let repair = false;
      try {
        for (let attempt = 0; attempt < LLM_LIMITS.requests; attempt += 1) {
          if (controller.signal.aborted) return failed("unavailable", "素材理解调用已取消");
          const result = await requestChat(
            endpoint,
            JSON.stringify({
              model: endpoint.model,
              stream: false,
              response_format: { type: "json_object" },
              messages: [
                {
                  role: "system",
                  content: `Return only JSON matching ${schema}. Do not identify people. ${repair ? "The previous output did not match this schema. Correct the JSON keys and value types." : ""}`,
                },
                { role: "user", content },
              ],
            }),
            transport,
            limits.request,
            controller.signal,
          );
          if (controller.signal.aborted) return failed("unavailable", "素材理解调用已取消");
          if (result.kind === "data") {
            const envelope = chatContent(result.value);
            if (envelope.kind === "refused") return failed("rejected", "素材理解请求被拒绝");
            const value = envelope.kind === "json" ? parse(envelope.value) : undefined;
            if (value !== undefined) return ok(value);
            if (envelope.kind !== "invalid" && !usedRepair) {
              usedRepair = true;
              repair = true;
              continue;
            }
          } else if (!result.fallback) return result.failure;
          if (usedBackup) return failed("unavailable", "素材理解未得到合规结果");
          usedBackup = true;
          endpoint = routes[role].backup;
          repair = false;
        }
        return failed("unavailable", "素材理解未得到合规结果");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controllers.delete(controller);
      }
    })();
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }

  const provider: LlmProvider = {
    status: "domestic-llm",
    configured: true,
    tagAsset(input) {
      if (
        !input ||
        !["image", "video", "audio", "document"].includes(input.kind) ||
        (input.text !== undefined && !validText(input.text)) ||
        (input.url !== undefined && !validUrl(input.url))
      )
        return Promise.resolve(failed("rejected", "素材理解输入不合法"));
      const schema = `{"description": nonempty string <=2000 characters, "tags": array of <=20 nonempty strings <=100 characters}; no other keys`;
      if (input.kind === "image") {
        if (!validUrl(input.url)) return Promise.resolve(failed("rejected", "素材理解输入不合法"));
        // 不把可能含姓名的 input.text 与图片同送；只描述内容，不识别人。由拥有者提供短期授权 URL。
        return run(
          "vision",
          [
            {
              type: "text",
              text: "Describe the image content and tags as JSON without identifying people.",
            },
            { type: "image_url", image_url: { url: input.url } },
          ],
          schema,
          tagOutput,
          input.signal,
        );
      }
      if (!validText(input.text))
        return Promise.resolve(
          failed(input.kind === "video" ? "unsupported" : "rejected", "素材理解需要已提取文本"),
        );
      return run("text", input.text, schema, tagOutput, input.signal);
    },
    extractKeyPoints(input) {
      if (!input) return Promise.resolve(failed("rejected", "素材理解输入不合法"));
      const count = input.maxPoints ?? 3;
      if (
        !validText(input.text) ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > LLM_LIMITS.points
      )
        return Promise.resolve(failed("rejected", "素材理解输入不合法"));
      return run(
        "text",
        input.text,
        `{"points": array of 1..${count} nonempty strings <=500 characters}; no other keys`,
        (value) => pointOutput(value, count),
        input.signal,
      );
    },
    summarizeAsset(input) {
      const prepared = prepareDigest(input);
      if (!prepared) return Promise.resolve(failed("rejected", "素材理解输入不合法"));
      return run("text", prepared.content, DIGEST_JSON_INSTRUCTIONS, prepared.parse, input.signal);
    },
  };
  return {
    provider,
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      closing ??= Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  };
}
