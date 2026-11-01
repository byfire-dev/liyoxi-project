// Only this checkout's current public-test ticket. Real immutable snapshot → PDF renderer → technical signer.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRuntime } from "../src/runtime.js";
import { createLogger } from "../src/logger.js";
import {
  createIdentityContext,
  uuidv7,
  systemClock,
  isAppError,
  lockRows,
} from "../src/kernel/index.js";
// NOT_SHIPPED test CLI: call the existing owner derivation without adding a production public API.
import { deriveOrder } from "../src/order/rederive.js";
import { createSla } from "../src/sla/index.js";
import { readCancelReviewHoldTargets, holdCancelReviewPauses } from "../src/delivery/index.js";
import { sampleStaffContext } from "../src/testing/approval.js";
import { IdSchema } from "@liyoxi/contract";
import {
  createM1LicenseRendering,
  M1_LICENSE_TEST_INPUTS,
  prepareM1LicenseInputs,
  parseOutputBatchLiveManifest,
} from "../src/testing/index.js";
import { fakeKeyEnv } from "../src/testing/staff.js";
import {
  DeliveryLiveScopeSchema,
  assertDeliveryScope,
} from "../src/testing/admin-live/delivery-known-media.js";
const root = fileURLToPath(new URL("../../../apps/admin/dist/tmp/", import.meta.url));
let phase = "context";
async function main() {
  if (
    process.env.APP_ENV !== "test" ||
    Object.keys(process.env).some((key) => key.endsWith("_FILE"))
  )
    throw new Error("W513仅接受无密钥文件的本轮test环境");
  const { values } = parseArgs({
    options: {
      context: { type: "string" },
      action: { type: "string", default: "render" },
      "request-id": { type: "string" },
    },
  });
  if (!values.context) throw new Error("W513需要本轮context");
  const path = await realpath(values.context);
  const context = JSON.parse(await readFile(path, "utf8")) as {
    fixtures?: {
      fixtures?: Record<
        string,
        { scope?: unknown; paused?: { scope?: unknown }; flow?: { scope?: unknown } }
      >;
    };
  };
  if (!["render", "pause", "withdraw", "cleanup-docs"].includes(values.action))
    throw new Error("W513动作不在白名单");
  const scope = DeliveryLiveScopeSchema.parse(
    ["render", "cleanup-docs"].includes(values.action)
      ? context.fixtures?.fixtures?.w513?.flow?.scope
      : context.fixtures?.fixtures?.w513?.paused?.scope,
  );
  if (path !== resolve(root, `admin-live-${scope.runId}`, "context.json"))
    throw new Error("W513拒绝其他检出或轮次");
  const env = {
    APP_ENV: "test" as const,
    LOG_LEVEL: "error" as const,
    DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/${scope.name}?options=-c%20role%3Dlyx_app`,
    REDIS_URL: "redis://127.0.0.1:6389/0",
    PORTAL_PUBLIC_ORIGIN: M1_LICENSE_TEST_INPUTS.portalPublicOrigin,
    MINIO: { endpoint: "http://127.0.0.1:9100", publicEndpoint: "http://127.0.0.1:9100" },
    ...fakeKeyEnv(),
  };
  assertDeliveryScope(env, scope);
  if (["render", "cleanup-docs"].includes(values.action)) {
    const manifest = parseOutputBatchLiveManifest(
      JSON.parse(
        await readFile(resolve(root, `admin-live-${scope.runId}`, "media-input.json"), "utf8"),
      ),
    );
    if (JSON.stringify(manifest.inputs.w513) !== JSON.stringify(scope))
      throw new Error("W513 context与正式manifest不符");
  }
  const rendering = values.action === "render" ? createM1LicenseRendering(systemClock) : undefined;
  const runtime = createRuntime({
    entry: values.action === "render" ? "worker" : "api",
    env,
    clock: systemClock,
    version: "lyxtest.w513",
    redisKeyPrefix: scope.prefix,
    ...(rendering ? { licenseRendering: rendering } : {}),
    logger: createLogger({
      svc: "worker",
      env: "test",
      level: "error",
      version: "lyxtest.w513",
      destination: process.stderr,
    }),
  });
  try {
    if (values.action === "cleanup-docs") {
      phase = "cleanup_documents";
      const files = await runtime.tx.run((tx) =>
        tx.licenseLetterRevision.findMany({
          where: {
            createdAt: { gte: new Date(scope.startedAt) },
            fileId: { not: null },
            licenseLetter: {
              entityId: scope.entityId,
              storeId: scope.storeId,
              orderItemId: scope.itemId,
              dramaOrderId: scope.orderId,
            },
          },
          include: { file: true },
        }),
      );
      for (const revision of files) {
        const file = revision.file;
        if (
          !file ||
          file.bucket !== "secure" ||
          file.category !== "legal_doc" ||
          file.entityId !== scope.entityId ||
          file.sha256 !== revision.pdfSha256
        )
          throw new Error("W513清理对象归属不符");
        const deleted = await runtime.providers.storage.delete({
          bucket: "secure",
          key: file.objectKey,
        });
        if (!deleted.ok) throw new Error("W513本轮PDF对象未清理");
      }
      const item = await runtime.tx.run((tx) =>
        tx.orderItem.findFirstOrThrow({
          where: {
            id: scope.itemId,
            entityId: scope.entityId,
            storeId: scope.storeId,
            dramaOrderId: scope.orderId,
          },
          include: { drama: true },
        }),
      );
      const poster = await runtime.tx.run((tx) =>
        tx.fileObject.findUniqueOrThrow({ where: { id: item.drama.posterFileId! } }),
      );
      if (
        item.drama.title !== `W513工单短剧-${scope.runId}` ||
        (item.dramaSnapshot as { posterFileId?: string }).posterFileId !== poster.id ||
        poster.objectKey !== `poster/w513/${scope.runId}.png` ||
        poster.category !== "poster" ||
        poster.bucket !== "pub" ||
        poster.scopeType !== "platform" ||
        poster.entityId !== null ||
        poster.storeId !== null ||
        poster.uploadActorType !== "system" ||
        poster.createdAt < new Date(scope.startedAt) ||
        !poster.sha256
      )
        throw new Error("W513本轮封面清理归属不符");
      const posterBytes = await runtime.providers.storage.readObject({
        bucket: poster.bucket,
        key: poster.objectKey,
        maxBytes: 1048576,
      });
      if (
        !posterBytes.ok ||
        createHash("sha256").update(posterBytes.value).digest("hex") !== poster.sha256
      )
        throw new Error("W513本轮封面实际字节不符");
      const posterDeleted = await runtime.providers.storage.delete({
        bucket: poster.bucket,
        key: poster.objectKey,
      });
      if (!posterDeleted.ok) throw new Error("W513本轮封面对象未清理");
      process.stdout.write(
        `${JSON.stringify({ ticketId: scope.ticketId, cleanedDocuments: files.length, cleanedPoster: true })}\n`,
      );
      return;
    }
    if (values.action !== "render") {
      const ticket = await runtime.tx.run((tx) =>
        tx.deliveryTicket.findFirstOrThrow({
          where: {
            id: scope.ticketId,
            entityId: scope.entityId,
            storeId: scope.storeId,
            orderItemId: scope.itemId,
            dramaOrderId: scope.orderId,
            createdAt: { gte: new Date(scope.startedAt) },
          },
        }),
      );
      const ctx = createIdentityContext({
        actor: { type: "staff", id: scope.uploaderId, client: "admin" },
        entityId: scope.entityId,
        storeId: scope.storeId,
      });
      if (values.action === "pause") {
        if (ticket.pauseCount || ticket.step !== "assigning")
          throw new Error("W513暂停仅接受原始在途工单");
        const id = uuidv7(),
          approvalId = uuidv7(),
          now = runtime.clock.now();
        // Authorized initial pending upstream inputs, never successful approval/refund/ledger or pause rows.
        phase = "pending_inputs";
        await runtime.tx.run(async (tx) => {
          if (await tx.cancelRequest.count({ where: { dramaOrderId: scope.orderId } }))
            throw new Error("W513已有取消输入");
          const item = await tx.orderItem.findUniqueOrThrow({ where: { id: scope.itemId } });
          await tx.approvalRequest.create({
            data: {
              id: approvalId,
              requestNo: `TK${id.replaceAll("-", "").slice(0, 18)}`,
              kind: "order_cancel",
              category: "approval",
              subjectType: "drama_order",
              subjectId: scope.orderId,
              entityId: scope.entityId,
              storeId: scope.storeId,
              status: "pending",
              summarySnapshot: {
                title: "W513未决取消上游输入",
                domain: { type: "cancel_request", id },
              },
              submitActorType: "staff",
              submitActorId: scope.uploaderId,
              submitClient: "admin",
              requesterStaffId: scope.uploaderId,
              submittedAt: now,
              createdAt: now,
              updatedAt: now,
            },
          });
          await tx.cancelRequest.create({
            data: {
              id,
              approvalRequestId: approvalId,
              kind: "order_cancel",
              entityId: scope.entityId,
              storeId: scope.storeId,
              dramaOrderId: scope.orderId,
              reasonCode: "merchant_request",
              note: "W513未决取消暂停输入",
              lineCount: 1,
              totalBasePoints: 100,
              totalDeductPoints: 0,
              totalRefundPoints: 100,
              status: "pending_approval",
              createdAt: now,
              updatedAt: now,
            },
          });
          await tx.cancelRequestLine.create({
            data: {
              id: uuidv7(),
              cancelRequestId: id,
              entityId: scope.entityId,
              storeId: scope.storeId,
              targetType: "order_item",
              targetId: scope.itemId,
              pointHoldId: item.pointHoldId,
              mode: "refund",
              stage: "ad_and_sample",
              stepAtSubmit: ticket.step,
              reasonClass: "merchant",
              chargePoints: 100,
              priorRequestedPoints: 0,
              ratioBp: 0,
              deductPoints: 0,
              refundPoints: 100,
              previewSnapshot: {
                qty: 100,
                backToOriginal: 100,
                convertedToAddon: 0,
                forfeited: 0,
                lots: [],
              },
              createdAt: now,
            },
          });
        });
        phase = "open_order_cancel";
        await runtime.tx.run(async (tx) => {
          await lockRows(tx, "entity", [scope.entityId]);
          await lockRows(tx, "store", [scope.storeId]);
          await lockRows(tx, "drama", [ticket.dramaId]);
          await lockRows(tx, "drama_order", [scope.orderId]);
          await lockRows(tx, "order_item", [scope.itemId]);
          await deriveOrder(
            tx,
            { assembly: runtime.assembly, flow: runtime.flow, clock: runtime.clock },
            scope.orderId,
            { openedCancelRequestId: id },
          );
          const opened = await tx.dramaOrder.findUniqueOrThrow({ where: { id: scope.orderId } });
          if (opened.openCancelRequestId !== id || opened.status !== "after_sale")
            throw new Error("W513未决取消父对象未实际打开");
        });
        phase = "hold_cancel_review";
        const held = await runtime.tx.run(async (tx) =>
          holdCancelReviewPauses(
            tx,
            { ...runtime, sla: createSla(runtime) },
            ctx,
            await readCancelReviewHoldTargets(tx, runtime.assembly, approvalId),
          ),
        );
        if (held.held !== 1) throw new Error("W513真实暂停未生效");
        process.stdout.write(
          `${JSON.stringify({ ticketId: scope.ticketId, requestId: id, approvalId, paused: true })}\n`,
        );
      } else {
        phase = "withdraw_scope";
        const id = IdSchema.parse(values["request-id"]);
        await runtime.tx.run((tx) =>
          tx.cancelRequest.findFirstOrThrow({
            where: {
              id,
              entityId: scope.entityId,
              storeId: scope.storeId,
              dramaOrderId: scope.orderId,
              kind: "order_cancel",
              status: "pending_approval",
              note: "W513未决取消暂停输入",
              createdAt: { gte: new Date(scope.startedAt) },
              approvalRequest: { requesterStaffId: scope.uploaderId, status: "pending" },
            },
          }),
        );
        const staff = await runtime.tx.run((tx) =>
          sampleStaffContext(tx, scope.uploaderId, { stepUpAt: runtime.clock.now() }),
        );
        phase = "withdraw_owner";
        const result = await runtime.cancelRequests.withdraw({ ctx, staff }, id, {
          note: "W513本轮演练撤回收尾",
        });
        phase = "withdraw_verify";
        const current = await runtime.tx.run((tx) =>
          tx.deliveryTicket.findUniqueOrThrow({ where: { id: scope.ticketId } }),
        );
        if (
          current.pauseCount ||
          result.status !== "not_executed" ||
          result.approval.status !== "withdrawn"
        )
          throw new Error("W513实际撤回未解除暂停");
        process.stdout.write(
          `${JSON.stringify({ ticketId: scope.ticketId, requestId: id, paused: false, status: result.status, approvalStatus: result.approval.status })}\n`,
        );
      }
      return;
    }
    const check = async () =>
      runtime.tx.run(async (tx) => {
        assertDeliveryScope(runtime.env, scope);
        const ticket = await tx.deliveryTicket.findFirstOrThrow({
          where: {
            id: scope.ticketId,
            entityId: scope.entityId,
            storeId: scope.storeId,
            orderItemId: scope.itemId,
            dramaOrderId: scope.orderId,
            createdAt: { gte: new Date(scope.startedAt) },
          },
        });
        if (
          ticket.pauseCount ||
          !["delivering", "awaiting_launch", "launch_verify", "in_service"].includes(ticket.step)
        )
          throw new Error("W513工单尚不符合授权准备条件");
      });
    await check();
    // Existing owned-test legal inputs only; this does not generate consent, a revision or readiness.
    phase = "render_test_inputs";
    await runtime.tx.run((tx) =>
      prepareM1LicenseInputs({
        db: tx,
        clock: runtime.clock,
        env: runtime.env,
        inputs: M1_LICENSE_TEST_INPUTS,
      }),
    );
    phase = "render_convergence";
    await runtime.tx.run((tx) =>
      runtime.licenseLetters.ensureLicenseReadiness(
        tx,
        [scope.itemId],
        `guard-w513-${scope.runId}`,
      ),
    );
    const revisions = await runtime.tx.run((tx) =>
      tx.licenseLetterRevision.findMany({
        where: {
          renderStatus: "queued",
          createdAt: { gte: new Date(scope.startedAt) },
          licenseLetter: {
            entityId: scope.entityId,
            storeId: scope.storeId,
            orderItemId: scope.itemId,
            dramaOrderId: scope.orderId,
            status: { not: "voided" },
          },
        },
        orderBy: { id: "asc" },
        take: 3,
        select: { id: true },
      }),
    );
    phase = "render_pdf";
    for (const revision of revisions) {
      await check();
      await runtime.docsRender.process({ revisionId: revision.id });
    }
    phase = "render_verify";
    const letters = await runtime.tx.run((tx) =>
      tx.licenseLetter.findMany({
        where: {
          entityId: scope.entityId,
          storeId: scope.storeId,
          orderItemId: scope.itemId,
          dramaOrderId: scope.orderId,
          status: { not: "voided" },
        },
        include: {
          currentRevision: { include: { file: true } },
          revisions: { orderBy: { revNo: "desc" }, take: 1 },
        },
      }),
    );
    if (!letters.length || letters.length > 2) throw new Error("W513必需授权集合不符");
    for (const letter of letters) {
      const revision = letter.currentRevision,
        file = revision?.file;
      if (
        !revision ||
        !file ||
        revision.id !== letter.revisions[0]?.id ||
        revision.renderStatus !== "ready" ||
        revision.signMode !== "platform_cert" ||
        !revision.certIssuer ||
        !revision.certSerial ||
        !revision.platformSignedAt ||
        !revision.pdfSha256 ||
        file.status !== "stored" ||
        file.category !== "legal_doc" ||
        file.bucket !== "secure" ||
        file.entityId !== scope.entityId ||
        file.storeId !== null ||
        file.sha256 !== revision.pdfSha256
      )
        throw new Error("W513授权实际渲染/归属/技术签署失败");
      const bytes = await runtime.providers.storage.readObject({
        bucket: "secure",
        key: file.objectKey,
        maxBytes: 1048576,
      });
      if (
        !bytes.ok ||
        Buffer.from(bytes.value.subarray(0, 5)).toString() !== "%PDF-" ||
        createHash("sha256").update(bytes.value).digest("hex") !== revision.pdfSha256
      )
        throw new Error("W513真实PDF字节证明不符");
    }
    const ready = await runtime.tx.run((tx) =>
      runtime.licenseLetters.ensureLicenseReadiness(
        tx,
        [scope.itemId],
        `guard-w513-verify-${scope.runId}`,
      ),
    );
    if (ready.length !== 1 || !ready[0]?.ready) throw new Error("W513真实reader仍未ready");
    process.stdout.write(
      `${JSON.stringify({ ticketId: scope.ticketId, orderItemId: scope.itemId, ready: true, rendered: revisions.length, letters: letters.length, signMode: "platform_cert", technicalTestCertificate: true })}\n`,
    );
  } finally {
    await runtime.close();
    await rendering?.close();
  }
}
main().catch((error: unknown) => {
  const reason = isAppError(error)
    ? [
        ["授权快照缺少平台法定主体", "licensor_missing"],
        ["授权快照所需的主体或门店事实不完整", "licensee_incomplete"],
        ["授权快照所需的剧目许可事实不完整", "license_scope_incomplete"],
        ["授权快照缺少有效的历史交易同意", "consent_incomplete"],
      ].find(([message]) => message === error.message)?.[1]
    : undefined;
  // Only fixed snapshot reasons may augment the existing safe phase diagnostic.
  if (phase === "render_convergence" && reason) phase += `_${reason}`;
  process.stderr.write(
    `${JSON.stringify({ evt: "w513.bridge.failed", phase, symbol: isAppError(error) ? error.error : "non_application" })}\n`,
  );
  process.stderr.write("W513本轮真实PDF准备拒绝或失败\n");
  process.exitCode = 1;
});
