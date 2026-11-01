import type { operations } from "@liyoxi/contract/types/admin";
import { AdTaskDetailSchema, ProductionRecordPageSchema } from "@liyoxi/contract";
import type { AppServices } from "../../../app/services";
import { readFailure } from "../../../lib/api-errors";

type Body<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { "application/json": infer T } };
}
  ? T
  : never;
export type AdQuery = NonNullable<operations["admin.ad.list"]["parameters"]["query"]>;
export type AdFilters = NonNullable<operations["admin.ad.summary"]["parameters"]["query"]>;
export type CreateVersionBody = Body<"admin.ad.adVersion.create">;
export type ChangeBody = Body<"admin.ad.requestChange">;
export type CancelBody = Body<"admin.ad.cancelRequest.create">;
export type CancelReason = Body<"admin.ad.cancelQuote">["reasonCode"];
export type Command =
  | { kind: "assign"; body: Body<"admin.ad.assign"> }
  | { kind: "return"; body: Body<"admin.ad.return"> }
  | { kind: "create-version"; body: CreateVersionBody }
  | { kind: "request-change"; body: ChangeBody }
  | { kind: "remind"; body: Body<"admin.ad.remind"> }
  | { kind: "cancel"; body: CancelBody }
  | { kind: "push"; versionId: string; body: Body<"admin.adVersion.push"> }
  | { kind: "mark-sent"; versionId: string; body: Body<"admin.adVersion.markSent"> };
export class AdFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const safeMessages: Record<string, string> = {
  PRODUCTION_NOT_READY: "视频仍在检查，请稍后重试登记",
  AD_VERSION_SPEC_INVALID: "视频规格或检查结果不符合推送要求，请核对后重试",
  FILE_NOT_USABLE: "该文件不可用于此广告，请检查入库、分类和归属",
  STATE_NOT_ALLOWED: "广告状态已变化，请刷新后重新操作",
  PRECONDITION_CHANGED: "当前事实已变化，请重新核对",
  RATE_LIMITED: "本日已催办，请稍后再试",
  PERMISSION_DENIED: "当前权限不能执行此操作",
  NOT_FOUND: "当前范围内未找到此广告",
};
async function unwrap<T>(result: {
  data?: { data: T };
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data) return result.data.data;
  const payload = result.error;
  const code =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : (await readFailure(result.response)).symbol;
  // Never turn a provider payload, signed URL or arbitrary details into page text.
  throw new AdFailure(code, safeMessages[code] ?? "请求未完成，请刷新事实后重试");
}
export function createAdTasksApi(services: Pick<AppServices, "api">) {
  const c = services.api.client;
  const get = (adId: string, signal?: AbortSignal) => readAd(c, adId, signal);
  const production = (fileId: string, adId: string, signal?: AbortSignal) =>
    readProduction(c, fileId, adId, signal);
  const checkFile = async (detail: AdDetail, fileId: string, signal?: AbortSignal) => {
    const file = await c
      .GET("/api/v1/admin/files/{fileId}", { params: { path: { fileId } }, signal })
      .then(unwrap);
    if (
      file.fileId !== fileId ||
      file.status !== "stored" ||
      file.category !== "ad_video" ||
      file.moderationState === "block" ||
      file.deletedAt ||
      file.erasedAt ||
      file.storeId !== detail.store.storeId ||
      file.entityId !== detail.store.entityId ||
      file.uploader.actorId !== detail.editor?.staffId
    )
      throw new AdFailure("FILE_NOT_USABLE", safeMessages.FILE_NOT_USABLE!);
    return file;
  };
  return {
    get,
    checkFile,
    production,
    async previewUrl(adId: string, versionId: string, signal: AbortSignal) {
      if (signal.aborted) throw new DOMException("预览已关闭", "AbortError");
      const current = await get(adId, signal);
      if (signal.aborted) throw new DOMException("预览已关闭", "AbortError");
      const preview =
        current.adId === adId
          ? current.versions.find((v) => v.adVersionId === versionId)?.preview
          : undefined;
      // This runs after the event's fresh request, never during React render.
      if (!preview || Date.parse(preview.expiresAt) <= Date.now())
        throw new Error("该版本暂无可用预览，请稍后刷新");
      return preview.url;
    },
    list: (query: AdQuery) => c.GET("/api/v1/admin/ads", { params: { query } }).then(unwrap),
    summary: (query: AdFilters) =>
      c.GET("/api/v1/admin/ads/summary", { params: { query } }).then(unwrap),
    staff: (page: number) =>
      c
        .GET("/api/v1/admin/staff", {
          params: {
            query: {
              roleKey: "editor",
              status: "active",
              withLoad: true,
              recommendPool: "editor",
              sort: "openWorkCount",
              pageSize: 50,
              page,
            },
          },
        })
        .then(unwrap),
    openWork: (staffId: string) =>
      c
        .GET("/api/v1/admin/staff/{staffId}/open-work", { params: { path: { staffId } } })
        .then(unwrap),
    cancelQuote: async (adId: string, reasonCode: CancelReason) => {
      const current = await get(adId);
      if (current.adId !== adId || !current.actions.includes("cancel"))
        throw new AdFailure("PRECONDITION_CHANGED", safeMessages.PRECONDITION_CHANGED!);
      return c
        .POST("/api/v1/admin/ads/{adId}/cancel-quote", {
          params: { path: { adId } },
          body: { reasonCode },
        })
        .then(unwrap);
    },
    async write(adId: string, command: Command, key: string, signal?: AbortSignal) {
      const current = await get(adId, signal);
      if (signal?.aborted) throw new DOMException("操作已关闭", "AbortError");
      const version =
        "versionId" in command
          ? current.versions.find((v) => v.adVersionId === command.versionId)
          : undefined;
      const allowed = version
        ? version.actions.includes(command.kind)
        : current.actions.includes(command.kind);
      if (
        current.adId !== adId ||
        !allowed ||
        (command.kind === "request-change" && command.body.versionNo !== current.latestVersionNo)
      )
        throw new AdFailure("PRECONDITION_CHANGED", safeMessages.PRECONDITION_CHANGED!);
      const common = { headers: { "Idempotency-Key": key }, signal };
      const path = { params: { path: { adId } } };
      if (command.kind === "create-version") {
        await checkFile(current, command.body.fileId, signal);
        if (
          !inspectionReady(
            await production(command.body.fileId, adId, signal),
            command.body.fileId,
            adId,
          )
        )
          throw new AdFailure("PRODUCTION_NOT_READY", safeMessages.PRODUCTION_NOT_READY!);
      }
      switch (command.kind) {
        case "assign":
          await c
            .POST("/api/v1/admin/ads/{adId}/assign", { ...path, ...common, body: command.body })
            .then(unwrap);
          break;
        case "return":
          await c
            .POST("/api/v1/admin/ads/{adId}/return", { ...path, ...common, body: command.body })
            .then(unwrap);
          break;
        case "create-version":
          await c
            .POST("/api/v1/admin/ads/{adId}/ad-versions", {
              ...path,
              ...common,
              body: command.body,
            })
            .then(unwrap);
          break;
        case "request-change":
          await c
            .POST("/api/v1/admin/ads/{adId}/request-change", {
              ...path,
              ...common,
              body: command.body,
            })
            .then(unwrap);
          break;
        case "remind":
          await c
            .POST("/api/v1/admin/ads/{adId}/remind", { ...path, ...common, body: command.body })
            .then(unwrap);
          break;
        case "cancel":
          await c
            .POST("/api/v1/admin/ads/{adId}/cancel-requests", {
              ...path,
              ...common,
              body: command.body,
            })
            .then(unwrap);
          break;
        case "push":
          await c
            .POST("/api/v1/admin/ad-versions/{adVersionId}/push", {
              ...common,
              params: { path: { adVersionId: command.versionId } },
              body: command.body,
            })
            .then(unwrap);
          break;
        case "mark-sent":
          await c
            .POST("/api/v1/admin/ad-versions/{adVersionId}/mark-sent", {
              ...common,
              params: { path: { adVersionId: command.versionId } },
              body: command.body,
            })
            .then(unwrap);
          break;
      }
      if (signal?.aborted) throw new DOMException("操作已关闭", "AbortError");
      return get(adId, signal);
    },
  };
}
export type AdApi = ReturnType<typeof createAdTasksApi>;
function readAd(c: AppServices["api"]["client"], adId: string, signal?: AbortSignal) {
  return c
    .GET("/api/v1/admin/ads/{adId}", { params: { path: { adId } }, signal })
    .then(unwrap)
    .then((value) => AdTaskDetailSchema.parse(value));
}
async function readProduction(
  c: AppServices["api"]["client"],
  fileId: string,
  adId: string,
  signal?: AbortSignal,
) {
  const page = await c
    .GET("/api/v1/admin/production-records", {
      params: { query: { fileIds: fileId, adId, kind: "ad" } },
      signal,
    })
    .then(unwrap)
    .then((value) => ProductionRecordPageSchema.parse(value));
  return (
    page.items.find(
      (row) => row.productionRecordId === fileId && row.adId === adId && row.kind === "ad",
    ) ?? null
  );
}
export type AdInspection = Awaited<ReturnType<typeof readProduction>>;
export function inspectionReady(facts: AdInspection, fileId: string, adId: string) {
  return (
    !!facts &&
    facts.productionRecordId === fileId &&
    facts.adId === adId &&
    facts.kind === "ad" &&
    facts.pipelineState === "ready" &&
    facts.check?.gate === "pass"
  );
}
export type AdDetail = Awaited<ReturnType<typeof readAd>>;
export type AdCard = Awaited<ReturnType<AdApi["list"]>>["items"][number];
export type AdVersion = AdDetail["versions"][number];
