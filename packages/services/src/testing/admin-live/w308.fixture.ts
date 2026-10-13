import { uuidv7 } from "../../kernel/index.js";
import { authKeysFromEnv, loadKeyring, openField, openMfaSecret } from "../../security/index.js";
import type { AdminLiveFixture } from "./context.js";

/** 只建立合法技术失败和未决定清单；后继状态只能由真实HTTP写口产生。 */
const fixture: AdminLiveFixture = async ({ runtime, make }) => {
  if (runtime.env.APP_ENV !== "test") throw new Error("W308只接受隔离live测试环境");
  const now = runtime.clock.now(),
    day = 86_400_000;
  const runs = [];
  for (const [label, state] of [
    ["approve", "proposed"],
    ["reject", "held"],
    ["conflict", "proposed"],
  ] as const) {
    const file = await make.fileObject({
      originalName: `W308-${label}-candidate.jpg`,
      declaredSize: 8n,
      sizeBytes: 8n,
      createdAt: new Date(now.getTime() - 2 * day),
      storedAt: new Date(now.getTime() - 2 * day),
      purgeAfter: new Date(now.getTime() - day),
    });
    const run = await runtime.tx.run((tx) =>
      tx.filePurgeRun.create({
        data: {
          id: uuidv7(),
          mode: state === "held" ? "auto" : "list_only",
          state,
          candidateCount: 1,
          candidateBytes: 8n,
          candidateIds: [file.id],
          byCategory: { poster: { count: 1, bytes: "8" } },
          heldReason: state === "held" ? "max_objects" : null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    runs.push({ label, purgeRunId: run.id, fileId: file.id, originalName: file.originalName });
  }
  const deleted = [];
  for (const [label, age] of [
    ["available", 1],
    ["expired", 31],
  ] as const) {
    const deletedAt = new Date(now.getTime() - age * day),
      old = new Date(deletedAt.getTime() - day),
      file = await make.fileObject({
        originalName: `W308-${label}-deleted.jpg`,
        status: "deleted",
        declaredSize: 8n,
        sizeBytes: 8n,
        createdAt: old,
        storedAt: old,
        deletedAt,
        purgeAfter: deletedAt,
      });
    deleted.push({ label, fileId: file.id, originalName: file.originalName });
  }
  const file = await make.fileObject({
    originalName: "W308-retry-pending.jpg",
    moderationState: "pending",
  });
  const handler = runtime.media.jobs.handlers.get("audit_image");
  if (!handler) throw new Error("W308真实audit_image处理器未装配");
  const job = await runtime.tx.run(async (tx) => {
    const row = await tx.mediaJob.create({
      data: {
        id: uuidv7(),
        kind: "audit_image",
        provider: handler.provider ?? runtime.providers.media.status,
        mode: "local",
        subjectType: "file_object",
        subjectId: file.id,
        dedupeKey: `audit_image:${file.id}:v1`,
        state: "failed",
        attemptNo: 3,
        maxAttempts: 3,
        input: {
          src: { bucket: file.bucket, key: file.objectKey, etag: file.etag },
          scenes: ["profile"],
        },
        errorCode: "CI_IMAGE_UNAVAILABLE",
        errorMessage: "W308_PRIVATE_UPSTREAM_DETAIL",
        isRetryable: true,
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + 15 * 60_000),
        startedAt: new Date(now.getTime() - 60_000),
        finishedAt: now,
        createdAt: new Date(now.getTime() - 60_000),
        updatedAt: now,
      },
    });
    if (!handler.validInput(row.input) || !(await handler.current(tx, row)))
      throw new Error("W308技术失败前置不满足真实重试处理器守卫");
    return row;
  });
  // 复用本轮合成财务员工，不增加员工或消费兄弟用例的恢复码。认证秘密仅供Node原生请求。
  const viewer = await runtime.tx.run((tx) =>
    tx.staff.findFirstOrThrow({ where: { name: "演练财务配置提议", status: "active" } }),
  );
  if (!viewer.totpSecretEnc) throw new Error("W308只读员工尚未完成真实MFA绑定");
  return {
    runs,
    deleted,
    job: { mediaJobId: job.id, fileId: file.id },
    viewer: {
      staffId: viewer.id,
      phone: openField(loadKeyring(runtime.env), "staff.phone_enc", viewer.phoneEnc),
      password: "Liyoxi-2026-view",
      totpSecret: openMfaSecret(
        authKeysFromEnv(runtime.env),
        "staff.totp_secret_enc",
        viewer.totpSecretEnc,
      ),
      totpLastStep: viewer.totpLastStep,
    },
  };
};
export default fixture;
