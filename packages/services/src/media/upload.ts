import {
  MIME_BY_EXT,
  UPLOAD_CATEGORIES,
  extensionOf,
  matchesMagic,
  maxUploadBytes,
} from "@liyoxi/shared/uploads";
import { AppError, createThreePhaseRunner, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { ProviderResult, StorageBucket } from "../providers/types.js";
import { owned, registerScope } from "./access.js";
import type {
  BoundMediaDeps,
  FileRow,
  MediaActor,
  MediaOptions,
  RegisterInput,
} from "./context.js";
import { adminView, requirePending, statusView } from "./views.js";
export function providerValue<T>(value: ProviderResult<T>): T {
  if (!value.ok) throw new AppError("PROVIDER_UNAVAILABLE", { cause: value });
  return value.value;
}
export const notifyPromote = async (deps: BoundMediaDeps, jobId: string) => {
  try {
    await deps.channel?.enqueue("promote", uuidv7(), { jobId });
  } catch {
    /* 唤醒失败由 30 秒扫描补回；media_job 是事实源。 */
  }
};
const tokenConflict = (index: number): never => {
  throw new AppError("VALIDATION_FAILED", {
    details: {
      fieldErrors: [
        {
          path: `files.${index}.clientToken`,
          message: "该上传标识已有不同大小或归属的登记，请重新生成 clientToken",
        },
      ],
    },
  });
};
const credential = async (deps: BoundMediaDeps, file: FileRow) => {
  const post = providerValue(
    await deps.storage.presignPost({
      bucket: file.incomingBucket as StorageBucket,
      key: file.incomingKey!,
      mime: file.declaredMime,
      maxBytes: Number(file.declaredSize),
      expiresSec: 600,
    }),
  );
  return {
    fileId: file.id,
    clientToken: file.clientToken!,
    status: "pending" as const,
    mode: "post" as const,
    bucket: new URL(post.url).pathname.split("/").filter(Boolean).at(-1) ?? file.incomingBucket!,
    region: "us-east-1",
    key: file.incomingKey!,
    post: { url: post.url, fields: post.fields },
    sts: null,
    chunkSize: null,
    chunkParallel: null,
    expiresAt: post.expiresAt.toISOString(),
    uploadExpiresAt: file.uploadExpiresAt!.toISOString(),
    credentialsLeft: 30 - file.stsIssued,
  };
};
function existingKey(file: FileRow) {
  return {
    uploadActorType: file.uploadActorType,
    uploadActorId: file.uploadActorId,
    category: file.category,
    status: "pending",
    uploadBatchId: null,
    ...(file.storeId === null ? { storeId: null } : { storeId: file.storeId }),
    clientToken: file.clientToken,
  };
}
export async function register(
  deps: BoundMediaDeps,
  actor: MediaActor,
  input: RegisterInput,
  options: MediaOptions = {},
) {
  // 先核准类别与归属，再校验内容：未开放类别不能以 MIME/扩展名错误绕过权限判据。
  await deps.tx.run((tx) => registerScope(tx, deps, actor, input));
  if (!deps.storage.configured) throw new AppError("PROVIDER_UNAVAILABLE");
  const now = deps.clock.now();
  const videoMaxMb = actor.merchant ? ((await deps.videoMaxMb?.()) ?? 100) : 200;
  if (
    input.files.length < 1 ||
    input.files.length > 9 ||
    (!actor.merchant && input.files.length !== 1)
  )
    throw new AppError("VALIDATION_FAILED");
  if (new Set(input.files.map((item) => item.clientToken)).size !== input.files.length)
    tokenConflict(0);
  const definition = UPLOAD_CATEGORIES[input.category];
  const validated = input.files.map((item, index) => {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(item.clientToken) ||
      !/^[1-9][0-9]*$/.test(item.sizeBytes) ||
      item.fileName.length < 1 ||
      item.fileName.length > 200
    )
      throw new AppError("VALIDATION_FAILED");
    const ext = extensionOf(item.fileName);
    if (!ext || !definition.exts.includes(ext))
      throw new AppError("FILE_TYPE_NOT_ALLOWED", { details: { allowedExts: definition.exts } });
    const declaredSize = BigInt(item.sizeBytes);
    const maxBytes = maxUploadBytes(
      input.category,
      ext,
      actor.merchant ? "weapp" : "admin",
      videoMaxMb,
    );
    if (declaredSize > maxBytes)
      throw new AppError("FILE_TOO_LARGE", {
        details: {
          maxBytes: maxBytes.toString(),
          canDelegate: actor.merchant !== undefined && ["mp4", "mov"].includes(ext),
        },
      });
    return { ...item, ext, declaredSize, index };
  });
  // 自然键冲突后整批回滚、重新签实际行；绝不把另一个归属的 credentials 返回给调用方。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const files = await deps.tx.run(async (tx) => {
      const scope = await registerScope(tx, deps, actor, input);
      const result: FileRow[] = [];
      for (const item of validated) {
        const id = uuidv7();
        const objectToken = uuidv7();
        const candidate: FileRow = {
          id,
          bucket: definition.bucket,
          objectKey: `${input.category}/${scope.storeId ?? scope.entityId ?? "platform"}/${objectToken}.${item.ext}`,
          incomingBucket: definition.bucket === "pub" ? "asset" : definition.bucket,
          incomingKey: `incoming/${id}/${objectToken}.${item.ext}`,
          category: input.category,
          ...scope,
          uploadActorType: actor.identity.actor.type,
          uploadActorId: actor.identity.actor.id,
          uploadClient: actor.identity.actor.client,
          uploadMode: "post",
          clientToken: item.clientToken,
          uploadBatchId: null,
          status: "pending",
          rejectReason: null,
          declaredSize: item.declaredSize,
          declaredMime: MIME_BY_EXT[item.ext]!,
          ext: item.ext,
          originalName: item.fileName,
          sizeBytes: null,
          mime: null,
          etag: null,
          crc64: null,
          incomingEtag: null,
          incomingCrc64: null,
          sha256: null,
          moderationState: "none",
          moderationDetail: null,
          stsIssued: 0,
          uploadExpiresAt: new Date(now.getTime() + 86_400_000),
          confirmingUntil: null,
          storedAt: null,
          firstLinkedAt: null,
          purgeAfter: null,
          deletedAt: null,
          erasedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const existing = await tx.fileObject.findFirst({ where: existingKey(candidate) });
        if (existing) {
          if (
            existing.declaredSize !== item.declaredSize ||
            existing.entityId !== candidate.entityId ||
            existing.scopeType !== candidate.scopeType
          )
            tokenConflict(item.index);
          requirePending(existing, now);
        }
        result.push(existing ?? candidate);
      }
      return result;
    });
    const credentials = await Promise.all(files.map((file) => credential(deps, file)));
    try {
      await deps.tx.run(async (tx) => {
        await registerScope(tx, deps, actor, input);
        await lockRows(tx, "file_object", files.map((file) => file.id).sort());
        for (const [index, file] of files.entries()) {
          const existing = await tx.fileObject.findFirst({ where: existingKey(file) });
          if (existing && existing.id !== file.id) throw new RegistrationRace();
          if (!existing) {
            // skipDuplicates 是 INSERT ... ON CONFLICT DO NOTHING；任何竞争都使整批重新准备。
            const { moderationDetail: _detail, ...data } = file;
            const inserted = await tx.fileObject.createMany({ data: [data], skipDuplicates: true });
            if (inserted.count !== 1) throw new RegistrationRace();
            await deps.guards.get(input.category)?.registered?.(tx, file.id, actor, input);
          } else {
            if (
              existing.declaredSize !== file.declaredSize ||
              existing.entityId !== file.entityId ||
              existing.scopeType !== file.scopeType
            )
              tokenConflict(index);
            requirePending(existing, deps.clock.now());
          }
        }
      }, options);
      return { items: credentials };
    } catch (error) {
      if (!(error instanceof RegistrationRace)) throw error;
    }
  }
  throw new AppError("BUSY");
}
class RegistrationRace extends Error {}
export async function refresh(
  deps: BoundMediaDeps,
  actor: MediaActor,
  fileId: string,
  options: MediaOptions = {},
) {
  const file = await deps.tx.run(async (tx) => {
    const row = await owned(tx, actor, fileId);
    requirePending(row, deps.clock.now());
    return row;
  }, options);
  return credential(deps, file);
}
export async function complete(
  deps: BoundMediaDeps,
  actor: MediaActor,
  fileId: string,
  options: MediaOptions = {},
  admin = false,
) {
  if (admin && !actor.staff) throw new AppError("NOT_FOUND");
  type Intent = { file: FileRow; marker: Date | null };
  const project = (tx: Tx, file: FileRow) =>
    admin ? adminView(tx, actor, file) : Promise.resolve(statusView(file));
  const view = await createThreePhaseRunner(deps).run<
    Awaited<ReturnType<typeof project>>,
    string | null,
    Intent
  >(
    {
      claim: async (tx) => {
        await lockRows(tx, "file_object", [fileId]);
        const file = await owned(tx, actor, fileId);
        if (file.status === "promoting" || file.status === "stored") return { file, marker: null };
        requirePending(file, deps.clock.now());
        if (file.confirmingUntil !== null && file.confirmingUntil > deps.clock.now())
          throw new AppError("CONFIRM_IN_PROGRESS");
        const marker = new Date(deps.clock.now().getTime() + 30_000);
        await tx.fileObject.updateMany({
          where: { id: fileId, status: "pending" },
          data: { confirmingUntil: marker, updatedAt: deps.clock.now() },
        });
        return { file, marker };
      },
      external: async ({ file, marker }) => {
        if (!marker) return null;
        const ref = { bucket: file.incomingBucket as StorageBucket, key: file.incomingKey! };
        const head = providerValue(await deps.storage.head(ref));
        if (!Number.isSafeInteger(head.size) || head.size < 0)
          throw new AppError("PROVIDER_UNAVAILABLE");
        if (!head.exists) throw new AppError("UPLOAD_NOT_FOUND");
        if (BigInt(head.size) !== file.declaredSize)
          throw new AppError("UPLOAD_REJECTED", { details: { rejectReason: "size_mismatch" } });
        if (!head.etag) throw new AppError("PROVIDER_UNAVAILABLE");
        const result = await deps.storage.readPrefix({
          ...ref,
          bytes: 4096,
          ifMatchEtag: head.etag,
        });
        if (!result.ok && result.reason === "rejected")
          throw new AppError("UPLOAD_REJECTED", {
            details: { rejectReason: "changed_after_confirm" },
          });
        const bytes = providerValue(result);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 4096)
          throw new AppError("PROVIDER_UNAVAILABLE");
        if (!matchesMagic(file.ext, bytes))
          throw new AppError("UPLOAD_REJECTED", { details: { rejectReason: "bad_magic" } });
        return head.etag;
      },
      settle: async (tx, etag, { marker }) => {
        await lockRows(tx, "file_object", [fileId]);
        const file = await owned(tx, actor, fileId);
        if (!marker) return project(tx, file);
        const changed = await tx.fileObject.updateMany({
          where: { id: fileId, status: "pending", confirmingUntil: marker },
          data: {
            status: "promoting",
            confirmingUntil: null,
            incomingEtag: etag,
            updatedAt: deps.clock.now(),
          },
        });
        if (changed.count !== 1) throw new AppError("CONFIRM_IN_PROGRESS");
        const now = deps.clock.now();
        await tx.mediaJob.createMany({
          data: [
            {
              id: uuidv7(),
              kind: "promote",
              provider: "local",
              mode: "local",
              subjectType: "file_object",
              subjectId: fileId,
              dedupeKey: `promote:${fileId}`,
              state: "queued",
              input: {},
              nextRunAt: now,
              deadlineAt: new Date(now.getTime() + 86_400_000),
              createdAt: now,
              updatedAt: now,
            },
          ],
          skipDuplicates: true,
        });
        await emitFile(tx, deps, actor, file, "file.uploaded");
        return project(tx, await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } }));
      },
      compensate: async (tx, { marker }, { error }) => {
        if (!marker) return;
        await lockRows(tx, "file_object", [fileId]);
        const rejected = error.error === "UPLOAD_REJECTED";
        const reason = (error.details as { rejectReason?: string } | undefined)?.rejectReason;
        const changed = await tx.fileObject.updateMany({
          where: { id: fileId, status: "pending", confirmingUntil: marker },
          data: {
            confirmingUntil: null,
            ...(rejected ? { status: "rejected", rejectReason: reason ?? "bad_magic" } : {}),
            updatedAt: deps.clock.now(),
          },
        });
        if (rejected && changed.count === 1)
          await emitFile(
            tx,
            deps,
            actor,
            await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } }),
            "file.rejected",
          );
      },
    },
    options,
  );
  if (options.idem?.replayed) return view;
  if (view.status === "promoting") {
    const job = await deps.tx.run((tx) =>
      tx.mediaJob.findUnique({ where: { dedupeKey: `promote:${fileId}` } }),
    );
    if (job) await notifyPromote(deps, job.id);
    if (BigInt(view.declaredSizeBytes) <= 32n * 1024n * 1024n) {
      const end = Date.now() + (deps.pollMs ?? 3000);
      while (Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const current = await deps.tx.run(async (tx) =>
          project(tx, await owned(tx, actor, fileId)),
        );
        if (current.status !== "promoting") return current;
      }
    }
  }
  return view;
}
export async function emitFile(
  tx: Tx,
  deps: BoundMediaDeps,
  actor: MediaActor,
  file: FileRow,
  type: "file.uploaded" | "file.stored" | "file.rejected",
) {
  await deps.events.emit(tx, actor.identity, {
    type,
    aggregate: { type: "file_object", id: file.id },
    entityId: file.entityId,
    storeId: file.storeId,
    dedupeKey: `${type}:${file.id}`,
    payload: { v: 1, fileId: file.id },
  });
}
export async function cancel(
  deps: BoundMediaDeps,
  actor: MediaActor,
  fileId: string,
  options: MediaOptions = {},
) {
  let incoming: { bucket: StorageBucket; key: string } | undefined;
  const result = await deps.tx.run(async (tx) => {
    await lockRows(tx, "file_object", [fileId]);
    const file = await owned(tx, actor, fileId);
    if (file.status === "expired") return statusView(file);
    if (
      file.status !== "pending" ||
      (file.confirmingUntil && file.confirmingUntil > deps.clock.now())
    )
      throw new AppError("STATE_NOT_ALLOWED");
    incoming = { bucket: file.incomingBucket as StorageBucket, key: file.incomingKey! };
    await tx.fileObject.updateMany({
      where: { id: fileId, status: "pending" },
      data: {
        status: "expired",
        incomingKey: null,
        confirmingUntil: null,
        updatedAt: deps.clock.now(),
      },
    });
    return statusView(await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } }));
  }, options);
  if (incoming && !options.idem?.replayed)
    await deps.storage.delete(incoming).catch(() => undefined);
  return result;
}
