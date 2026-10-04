// 归“约定”的通用结构（约定 C87）：DictRef、SentryEnvelope。CursorPage<T> 在 pagination.ts。
// 其余公共结构（SignedUrl、AdminPage<T>、ImageRef、PendingConsent 等）归各接口文档，随各域第一个后端 PR。
import { z } from "../zod.js";

/** 字典项在响应里的形态 { code, name }（约定 C85）。请求只收编码 */
export const DictRefSchema = z.object({ code: z.string(), name: z.string() }).openapi("DictRef");
export type DictRef = z.infer<typeof DictRefSchema>;

/** 前端错误上报原文的上限：200KB */
export const SENTRY_ENVELOPE_MAX_BYTES = 200 * 1024;

/**
 * 前端错误上报的请求体：Sentry envelope 原文（Content-Type: application/x-sentry-envelope），
 * 三端的 POST /<端>/client-errors 同形。字节上限由请求体大小限制把关，这里的 maxLength 只是不超过它的上界。
 */
export const SentryEnvelopeSchema = z
  .string()
  .min(1)
  .max(SENTRY_ENVELOPE_MAX_BYTES)
  .openapi("SentryEnvelope", { description: "Sentry envelope 原文，≤200KB" });
export type SentryEnvelope = z.infer<typeof SentryEnvelopeSchema>;
