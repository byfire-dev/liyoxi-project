import { AdminFileCreateBodySchema, FileRegistrationSchema } from "@liyoxi/contract";
import { z } from "zod";
import type { Runtime } from "../../runtime.js";
import type { StorageBucket } from "../../providers/types.js";
import type { Env } from "../../kernel/index.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";

export const MerchantAssetLiveScopeSchema = z.strictObject({
  runId: z.string().regex(/^[a-f0-9]{16}$/),
  name: z.string(),
  prefix: z.string(),
  startedAt: z.iso.datetime(),
  staffId: z.uuid(),
  storeId: z.uuid(),
});
type Scope = z.infer<typeof MerchantAssetLiveScopeSchema>;
type Category = "store_asset" | "portrait_auth";
interface Intent {
  category: Category;
  clientToken: string;
  fileId?: string;
  refs?: readonly Ref[];
}
interface Ref {
  bucket: StorageBucket;
  key: string;
}
export interface MerchantAssetUploadFile {
  id: string;
  category: string;
  scopeType: string;
  storeId: string | null;
  onBehalfStoreId: string | null;
  uploadActorType: string;
  uploadActorId: string | null;
  uploadClient: string | null;
  clientToken: string | null;
  createdAt: Date;
  status: string;
  bucket: string;
  objectKey: string;
  incomingBucket: string | null;
  incomingKey: string | null;
}
/** Narrow ports permit pure lifecycle tests; the live binding below supplies real indexed reads. */
export interface MerchantAssetUploadPorts {
  env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL">;
  prefix: string;
  scope: unknown;
  read(intent: Readonly<Intent>): Promise<MerchantAssetUploadFile | null>;
  jobs(fileId: string): Promise<readonly string[]>;
  promote(jobId: string): Promise<unknown>;
  remove(ref: Ref): Promise<void>;
}
export function createMerchantAssetUploadController(ports: MerchantAssetUploadPorts) {
  const scope = MerchantAssetLiveScopeSchema.parse(ports.scope);
  const actual = assertDeliveryLiveEnvironment(ports.env);
  if (
    scope.runId !== actual.runId ||
    scope.name !== actual.name ||
    scope.prefix !== actual.prefix ||
    ports.prefix !== actual.prefix
  )
    throw new Error("素材上传范围不属于本轮隔离环境");
  const intents = new Map<string, Intent>();
  const pending = new Set<Promise<Response>>();
  let stopping = false;
  let closed: Promise<void> | undefined;
  function remember(intent: Intent, file: MerchantAssetUploadFile) {
    const bucket: StorageBucket = intent.category === "store_asset" ? "asset" : "secure";
    if (
      file.category !== intent.category ||
      file.scopeType !== "store" ||
      file.storeId !== scope.storeId ||
      file.onBehalfStoreId !== scope.storeId ||
      file.uploadActorType !== "staff" ||
      file.uploadActorId !== scope.staffId ||
      file.uploadClient !== "admin" ||
      file.clientToken !== intent.clientToken ||
      file.createdAt < new Date(scope.startedAt) ||
      (intent.fileId !== undefined && intent.fileId !== file.id) ||
      file.bucket !== bucket ||
      !file.objectKey.startsWith(`${intent.category}/${scope.storeId}/`) ||
      file.objectKey.includes("..") ||
      (file.incomingKey !== null &&
        (file.incomingBucket !== bucket ||
          !file.incomingKey.startsWith(`incoming/${file.id}/`) ||
          file.incomingKey.includes("..")))
    )
      throw new Error("素材上传文件不属于本轮登记");
    intent.fileId = file.id;
    intent.refs ??= [
      { bucket, key: file.objectKey },
      ...(file.incomingKey === null ? [] : [{ bucket, key: file.incomingKey }]),
    ];
  }
  return {
    beginStop() {
      stopping = true;
    },
    async fetch(
      request: Request,
      next: () => Promise<Response>,
      staffId: () => Promise<string | null>,
    ): Promise<Response> {
      const path = new URL(request.url).pathname;
      const registering = request.method === "POST" && path === "/api/v1/admin/files";
      const completing =
        request.method === "POST"
          ? /^\/api\/v1\/admin\/files\/([0-9a-f-]{36})\/complete$/.exec(path)?.[1]
          : undefined;
      if (!registering && !completing) return next();
      if (stopping) return new Response(null, { status: 503 });
      const work = (async () => {
        let intent: Intent | undefined;
        if (registering) {
          const body = AdminFileCreateBodySchema.safeParse(
            await request
              .clone()
              .json()
              .catch(() => undefined),
          );
          if (
            !body.success ||
            !["store_asset", "portrait_auth"].includes(body.data.category) ||
            body.data.storeId !== scope.storeId ||
            body.data.onBehalfStore !== true ||
            !/\.(?:png|jpe?g)$/i.test(body.data.fileName) ||
            BigInt(body.data.sizeBytes) > 1_048_576n
          )
            return next();
          if ((await staffId()) !== scope.staffId) return next();
          if (stopping) return new Response(null, { status: 503 });
          intent = intents.get(body.data.clientToken);
          if (intent && intent.category !== body.data.category)
            throw new Error("素材上传标识已有其他分类");
          if (!intent) {
            if (intents.size >= 8) throw new Error("素材上传登记超过本轮八个文件上限");
            intent = {
              category: body.data.category === "store_asset" ? "store_asset" : "portrait_auth",
              clientToken: body.data.clientToken,
            };
            // Retain the exact request token before IO, including a lost/failed registration response.
            intents.set(intent.clientToken, intent);
          }
        } else {
          intent = [...intents.values()].find((one) => one.fileId === completing);
          if (!intent || (await staffId()) !== scope.staffId) return next();
        }
        const response = await next();
        if (!response.ok) return response;
        let registeredFileId: string | undefined;
        if (registering) {
          const body = (await response.clone().json()) as { data: unknown };
          const registered = FileRegistrationSchema.parse(body.data);
          registeredFileId = registered.fileId;
        }
        const file = await ports.read(
          registeredFileId ? { ...intent, fileId: registeredFileId } : intent,
        );
        if (!file) throw new Error("素材上传实际登记文件缺失");
        if (registeredFileId && file.id !== registeredFileId)
          throw new Error("素材上传响应与实际文件不符");
        remember(intent, file);
        if (completing && !stopping && file.status === "promoting") {
          for (const jobId of await ports.jobs(file.id)) {
            if (stopping) break;
            await ports.promote(jobId);
          }
        }
        return response;
      })();
      pending.add(work);
      try {
        return await work;
      } finally {
        pending.delete(work);
      }
    },
    close() {
      stopping = true;
      return (closed ??= (async () => {
        const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([...pending]);
        for (const intent of intents.values()) {
          // Also recover a committed registration whose response was interrupted; no broad scan.
          results.push(
            ...(await Promise.allSettled([
              (async () => {
                if (!intent.refs) {
                  const file = await ports.read(intent);
                  if (file) remember(intent, file);
                }
                const removals = await Promise.allSettled(
                  (intent.refs ?? []).map((ref) => ports.remove(ref)),
                );
                if (removals.some((result) => result.status === "rejected"))
                  throw new Error("素材上传本轮对象清理失败");
              })(),
            ])),
          );
        }
        intents.clear();
        if (results.some((result) => result.status === "rejected"))
          throw new Error("素材上传本轮执行或清理未全部完成");
      })());
    },
  };
}

/** No worker sweep: only exact successful HTTP registration intents in this owned fixture. */
export function createMerchantAssetLiveUploadPump(runtime: Runtime, raw: unknown, prefix: string) {
  const scope: Scope = MerchantAssetLiveScopeSchema.parse(raw);
  return createMerchantAssetUploadController({
    env: runtime.env,
    prefix,
    scope,
    read: (intent) =>
      runtime.tx.run((tx) =>
        tx.fileObject.findFirst({
          where: {
            ...(intent.fileId ? { id: intent.fileId } : {}),
            clientToken: intent.clientToken,
            category: intent.category,
            storeId: scope.storeId,
            onBehalfStoreId: scope.storeId,
            scopeType: "store",
            uploadActorType: "staff",
            uploadActorId: scope.staffId,
            uploadClient: "admin",
            uploadBatchId: null,
            createdAt: { gte: new Date(scope.startedAt) },
          },
        }),
      ),
    jobs: (fileId) =>
      runtime.tx.run(async (tx) =>
        (
          await tx.mediaJob.findMany({
            where: {
              kind: "promote",
              provider: "local",
              mode: "local",
              subjectType: "file_object",
              subjectId: fileId,
              dedupeKey: `promote:${fileId}`,
              parentType: null,
              parentId: null,
              state: "queued",
              nextRunAt: { lte: runtime.clock.now() },
            },
            select: { id: true },
            take: 1,
          })
        ).map((job) => job.id),
      ),
    promote: (jobId) => runtime.media.promote({ jobId }),
    async remove(ref) {
      const result = await runtime.providers.storage.delete(ref);
      if (!result.ok) throw new Error("素材上传本轮对象删除失败");
    },
  });
}
