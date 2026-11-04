import { AdminFileCreateBodySchema, FileRegistrationSchema, IdSchema } from "@liyoxi/contract";
import { extensionOf, maxUploadBytes } from "@liyoxi/shared/uploads";
import { z } from "zod";
import type { Runtime } from "../../runtime.js";
import type { Env } from "../../kernel/index.js";
import { assertDeliveryLiveEnvironment } from "./delivery-known-media.js";

const ScopeSchema = z.strictObject({
  runId: z.string().regex(/^[a-f0-9]{16}$/),
  name: z.string(),
  prefix: z.string(),
  startedAt: z.iso.datetime(),
  staffId: IdSchema,
  entityId: IdSchema,
  storeId: IdSchema,
});
export const parseW609EvidenceUploadScope = (raw: unknown) => ScopeSchema.parse(raw);
interface Ref {
  bucket: "secure";
  key: string;
}
interface Intent {
  clientToken: string;
  fileId?: string;
  refs?: Ref[];
}
export interface W609EvidenceUploadFile {
  id: string;
  category: string;
  scopeType: string;
  entityId: string | null;
  storeId: string | null;
  onBehalfStoreId: string | null;
  uploadActorType: string;
  uploadActorId: string | null;
  uploadClient: string | null;
  clientToken: string | null;
  uploadBatchId: string | null;
  createdAt: Date;
  status: string;
  ext: string;
  bucket: string;
  objectKey: string;
  incomingBucket: string | null;
  incomingKey: string | null;
}
export interface W609EvidenceUploadPorts {
  env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL">;
  prefix: string;
  scope: unknown;
  read(intent: Readonly<Intent>): Promise<W609EvidenceUploadFile | null>;
  jobs(fileId: string): Promise<readonly string[]>;
  promote(jobId: string): Promise<unknown>;
  remove(ref: Ref): Promise<void>;
}
/** 仅 W609 本轮八个现场证据意图；原 HTTP 响应不变，真实 media.promote 完成入库。
 * 不扩大任何旧泵范围，不扫描全库，不改变原验收时限。 */
export function createW609EvidenceUploadController(ports: W609EvidenceUploadPorts) {
  const scope = ScopeSchema.parse(ports.scope),
    actual = assertDeliveryLiveEnvironment(ports.env);
  if (
    scope.runId !== actual.runId ||
    scope.name !== actual.name ||
    scope.prefix !== actual.prefix ||
    ports.prefix !== actual.prefix
  )
    throw new Error("W609证据上传范围不属于本轮隔离环境");
  const intents = new Map<string, Intent>(),
    pending = new Set<Promise<Response>>();
  let stopping = false,
    closed: Promise<void> | undefined;
  function remember(intent: Intent, file: W609EvidenceUploadFile) {
    if (
      file.category !== "evidence" ||
      file.bucket !== "secure" ||
      file.scopeType !== "store" ||
      file.entityId !== scope.entityId ||
      file.storeId !== scope.storeId ||
      file.onBehalfStoreId !== null ||
      file.uploadActorType !== "staff" ||
      file.uploadActorId !== scope.staffId ||
      file.uploadClient !== "admin" ||
      file.uploadBatchId !== null ||
      file.clientToken !== intent.clientToken ||
      file.createdAt < new Date(scope.startedAt) ||
      !["jpg", "jpeg", "png"].includes(file.ext) ||
      (intent.fileId !== undefined && intent.fileId !== file.id) ||
      !file.objectKey.startsWith(`evidence/${scope.storeId}/`) ||
      file.objectKey.includes("..") ||
      (file.incomingKey !== null &&
        (file.incomingBucket !== "secure" ||
          !file.incomingKey.startsWith(`incoming/${file.id}/`) ||
          file.incomingKey.includes("..")))
    )
      throw new Error("W609证据上传文件不属于本轮登记");
    intent.fileId = file.id;
    intent.refs ??= [
      { bucket: "secure", key: file.objectKey },
      ...(file.incomingKey ? [{ bucket: "secure" as const, key: file.incomingKey }] : []),
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
    ) {
      const path = new URL(request.url).pathname,
        registering = request.method === "POST" && path === "/api/v1/admin/files",
        completing =
          request.method === "POST"
            ? /^\/api\/v1\/admin\/files\/([0-9a-f-]{36})\/complete$/.exec(path)?.[1]
            : undefined;
      if (!registering && !completing) return next();
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
            body.data.category !== "evidence" ||
            body.data.storeId !== scope.storeId ||
            body.data.entityId !== undefined ||
            body.data.onBehalfStore === true
          )
            return next();
          const ext = extensionOf(body.data.fileName);
          if (
            !ext ||
            !["jpg", "jpeg", "png"].includes(ext) ||
            BigInt(body.data.sizeBytes) > maxUploadBytes("evidence", ext, "admin") ||
            (await staffId()) !== scope.staffId
          )
            return next();
          if (stopping) return new Response(null, { status: 503 });
          const key = body.data.clientToken;
          intent = intents.get(key);
          if (!intent) {
            if (intents.size >= 8) throw new Error("W609证据上传超过本轮八文件上限");
            intent = { clientToken: body.data.clientToken };
            // 先记精确意图；登记已提交但应答丢失时，关闭仍能按token恢复清理。
            intents.set(key, intent);
          }
        } else {
          intent = [...intents.values()].find((value) => value.fileId === completing);
          if (!intent || (await staffId()) !== scope.staffId) return next();
          if (stopping) return new Response(null, { status: 503 });
        }
        const response = await next();
        if (!response.ok) return response;
        const registered = registering
          ? FileRegistrationSchema.parse(
              ((await response.clone().json()) as { data: unknown }).data,
            ).fileId
          : undefined;
        const file = await ports.read(registered ? { ...intent, fileId: registered } : intent);
        if (!file || (registered !== undefined && file.id !== registered))
          throw new Error("W609证据上传真实登记缺失或关联不符");
        remember(intent, file);
        if (completing && !stopping && file.status === "promoting")
          for (const jobId of await ports.jobs(file.id)) {
            if (stopping) break;
            await ports.promote(jobId);
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
        for (const intent of intents.values())
          results.push(
            ...(await Promise.allSettled([
              (async () => {
                if (!intent.refs) {
                  const file = await ports.read(intent);
                  if (file) remember(intent, file);
                }
                const removed = await Promise.allSettled(
                  (intent.refs ?? []).map((ref) => ports.remove(ref)),
                );
                if (removed.some((result) => result.status === "rejected"))
                  throw new Error("W609证据本轮对象清理失败");
              })(),
            ])),
          );
        intents.clear();
        if (results.some((result) => result.status === "rejected"))
          throw new Error("W609证据本轮执行或清理未全部完成");
      })());
    },
  };
}
export function createW609EvidenceLiveUploadPump(runtime: Runtime, scope: unknown, prefix: string) {
  const parsed = ScopeSchema.parse(scope);
  return createW609EvidenceUploadController({
    env: runtime.env,
    prefix,
    scope: parsed,
    read: (intent) =>
      runtime.tx.run((tx) =>
        tx.fileObject.findFirst({
          where: {
            ...(intent.fileId ? { id: intent.fileId } : {}),
            category: "evidence",
            bucket: "secure",
            scopeType: "store",
            entityId: parsed.entityId,
            storeId: parsed.storeId,
            onBehalfStoreId: null,
            uploadActorType: "staff",
            uploadActorId: parsed.staffId,
            uploadClient: "admin",
            uploadBatchId: null,
            clientToken: intent.clientToken,
            createdAt: { gte: new Date(parsed.startedAt) },
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
      if (!result.ok) throw new Error("W609证据本轮对象删除失败");
    },
  });
}
