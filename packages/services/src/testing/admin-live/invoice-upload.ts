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
  entityIds: z
    .array(IdSchema)
    .min(1)
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const parseInvoiceLiveUploadScope = (raw: unknown) => ScopeSchema.parse(raw);
interface Ref {
  bucket: "secure";
  key: string;
}
interface Intent {
  entityId: string;
  clientToken: string;
  fileId?: string;
  refs?: Ref[];
}
export interface InvoiceUploadFile {
  id: string;
  category: string;
  scopeType: string;
  entityId: string | null;
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
export interface InvoiceUploadPorts {
  env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL">;
  prefix: string;
  scope: unknown;
  read(intent: Readonly<Intent>): Promise<InvoiceUploadFile | null>;
  jobs(fileId: string): Promise<readonly string[]>;
  promote(jobId: string): Promise<unknown>;
  remove(ref: Ref): Promise<void>;
}
/** 本轮发票独立边界；不改变旧凭证/内容/素材泵的范围或执行预算。 */
export function createInvoiceUploadController(ports: InvoiceUploadPorts) {
  const scope = ScopeSchema.parse(ports.scope),
    actual = assertDeliveryLiveEnvironment(ports.env);
  if (
    scope.runId !== actual.runId ||
    scope.name !== actual.name ||
    scope.prefix !== actual.prefix ||
    ports.prefix !== actual.prefix
  )
    throw new Error("发票上传范围不属于本轮隔离环境");
  const intents = new Map<string, Intent>(),
    pending = new Set<Promise<Response>>();
  let stopping = false,
    closed: Promise<void> | undefined;
  function remember(intent: Intent, file: InvoiceUploadFile) {
    if (
      file.category !== "invoice" ||
      file.bucket !== "secure" ||
      file.scopeType !== "entity" ||
      file.entityId !== intent.entityId ||
      !scope.entityIds.includes(file.entityId) ||
      file.uploadActorType !== "staff" ||
      file.uploadActorId !== scope.staffId ||
      file.uploadClient !== "admin" ||
      file.uploadBatchId !== null ||
      file.clientToken !== intent.clientToken ||
      file.createdAt < new Date(scope.startedAt) ||
      !["pdf", "ofd", "xml"].includes(file.ext) ||
      (intent.fileId !== undefined && intent.fileId !== file.id) ||
      !file.objectKey.startsWith(`invoice/${intent.entityId}/`) ||
      file.objectKey.includes("..") ||
      (file.incomingKey !== null &&
        (file.incomingBucket !== "secure" ||
          !file.incomingKey.startsWith(`incoming/${file.id}/`) ||
          file.incomingKey.includes("..")))
    )
      throw new Error("发票上传文件不属于本轮登记");
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
            body.data.category !== "invoice" ||
            !body.data.entityId ||
            !scope.entityIds.includes(body.data.entityId)
          )
            return next();
          const ext = extensionOf(body.data.fileName);
          if (
            !ext ||
            !["pdf", "ofd", "xml"].includes(ext) ||
            BigInt(body.data.sizeBytes) > maxUploadBytes("invoice", ext, "admin") ||
            (await staffId()) !== scope.staffId
          )
            return next();
          if (stopping) return new Response(null, { status: 503 });
          const key = JSON.stringify([body.data.entityId, body.data.clientToken]);
          intent = intents.get(key);
          if (!intent) {
            if (intents.size >= 6) throw new Error("发票上传超过本轮六文件上限");
            intent = { entityId: body.data.entityId, clientToken: body.data.clientToken };
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
          throw new Error("发票上传真实登记缺失或关联不符");
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
                  throw new Error("发票本轮对象清理失败");
              })(),
            ])),
          );
        intents.clear();
        if (results.some((result) => result.status === "rejected"))
          throw new Error("发票本轮执行或清理未全部完成");
      })());
    },
  };
}
export function createInvoiceLiveUploadPump(runtime: Runtime, scope: unknown, prefix: string) {
  const parsed = ScopeSchema.parse(scope);
  return createInvoiceUploadController({
    env: runtime.env,
    prefix,
    scope: parsed,
    read: (intent) =>
      runtime.tx.run((tx) =>
        tx.fileObject.findFirst({
          where: {
            ...(intent.fileId ? { id: intent.fileId } : {}),
            category: "invoice",
            bucket: "secure",
            scopeType: "entity",
            entityId: intent.entityId,
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
      if (!result.ok) throw new Error("发票本轮对象删除失败");
    },
  });
}
