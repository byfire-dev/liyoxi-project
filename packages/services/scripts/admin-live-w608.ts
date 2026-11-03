// NOT_SHIPPED: the current W608 item's real immutable license snapshot, PDF renderer and signer.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createRuntime } from "../src/runtime.js";
import { createLogger } from "../src/logger.js";
import { systemClock, isAppError } from "../src/kernel/index.js";
import {
  createM1LicenseRendering,
  M1_LICENSE_TEST_INPUTS,
  prepareM1LicenseInputs,
  parseOutputBatchLiveManifest,
} from "../src/testing/index.js";
import { fakeKeyEnv } from "../src/testing/staff.js";
import { assertW608LiveScope, parseW608LiveScope } from "../src/testing/admin-live/w608-scope.js";
const root = fileURLToPath(new URL("../../../apps/admin/dist/tmp/", import.meta.url));
let phase = "context";
function guard(value: unknown): asserts value {
  if (!value) throw new Error("W608 current-run document ownership or evidence mismatch");
}
async function main() {
  guard(
    process.env.APP_ENV === "test" &&
      !Object.keys(process.env).some((key) => key.endsWith("_FILE")),
  );
  const { values } = parseArgs({
    options: { context: { type: "string" }, action: { type: "string", default: "render" } },
  });
  guard(values.context && ["render", "cleanup-docs"].includes(values.action));
  const path = await realpath(values.context),
    context = JSON.parse(await readFile(path, "utf8")) as {
      fixtures?: { fixtures?: { w608?: { scope?: unknown } } };
    };
  const scope = parseW608LiveScope(context.fixtures?.fixtures?.w608?.scope);
  guard(path === (await realpath(resolve(root, `admin-live-${scope.runId}`, "context.json"))));
  const manifest = parseOutputBatchLiveManifest(
    JSON.parse(
      await readFile(resolve(root, `admin-live-${scope.runId}`, "media-input.json"), "utf8"),
    ),
  );
  guard(JSON.stringify(manifest.inputs.w608) === JSON.stringify(scope));
  const env = {
    APP_ENV: "test" as const,
    LOG_LEVEL: "error" as const,
    DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/${scope.name}?options=-c%20role%3Dlyx_app`,
    REDIS_URL: "redis://127.0.0.1:6389/0",
    PORTAL_PUBLIC_ORIGIN: M1_LICENSE_TEST_INPUTS.portalPublicOrigin,
    MINIO: { endpoint: "http://127.0.0.1:9100", publicEndpoint: "http://127.0.0.1:9100" },
    ...fakeKeyEnv(),
  };
  const rendering = values.action === "render" ? createM1LicenseRendering(systemClock) : undefined;
  const runtime = createRuntime({
    entry: rendering ? "worker" : "api",
    env,
    clock: systemClock,
    version: "lyxtest.w608",
    redisKeyPrefix: scope.prefix,
    ...(rendering ? { licenseRendering: rendering } : {}),
    logger: createLogger({
      svc: "worker",
      env: "test",
      level: "error",
      version: "lyxtest.w608",
      destination: process.stderr,
    }),
  });
  try {
    await assertW608LiveScope(runtime, scope);
    const where = {
      entityId: scope.entityId,
      storeId: scope.storeId,
      orderItemId: scope.itemId,
      dramaOrderId: scope.orderId,
    };
    if (values.action === "cleanup-docs") {
      phase = "cleanup_documents";
      const revisions = await runtime.tx.run((tx) =>
        tx.licenseLetterRevision.findMany({
          where: {
            createdAt: { gte: new Date(scope.startedAt) },
            fileId: { not: null },
            licenseLetter: where,
          },
          include: { file: true },
        }),
      );
      for (const revision of revisions) {
        const file = revision.file;
        guard(
          file &&
            file.bucket === "secure" &&
            file.category === "legal_doc" &&
            file.entityId === scope.entityId &&
            file.sha256 === revision.pdfSha256,
        );
        guard(
          (await runtime.providers.storage.delete({ bucket: "secure", key: file.objectKey })).ok,
        );
      }
      process.stdout.write(
        `${JSON.stringify({ ticketId: scope.ticketId, cleanedDocuments: revisions.length })}\n`,
      );
      return;
    }
    const check = async () => {
      await assertW608LiveScope(runtime, scope);
      const ticket = await runtime.tx.run((tx) =>
        tx.deliveryTicket.findUniqueOrThrow({ where: { id: scope.ticketId } }),
      );
      guard(
        !ticket.pauseCount &&
          ["delivering", "awaiting_launch", "launch_verify", "in_service"].includes(ticket.step),
      );
    };
    await check();
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
        `guard-w608-${scope.runId}`,
      ),
    );
    const revisions = await runtime.tx.run((tx) =>
      tx.licenseLetterRevision.findMany({
        where: {
          renderStatus: "queued",
          createdAt: { gte: new Date(scope.startedAt) },
          licenseLetter: { ...where, status: { not: "voided" } },
        },
        orderBy: { id: "asc" },
        take: 3,
        select: { id: true },
      }),
    );
    guard(revisions.length > 0 && revisions.length <= 2);
    phase = "render_pdf";
    for (const revision of revisions) {
      await check();
      await runtime.docsRender.process({ revisionId: revision.id });
    }
    phase = "render_verify";
    const letters = await runtime.tx.run((tx) =>
      tx.licenseLetter.findMany({
        where: { ...where, status: { not: "voided" } },
        include: {
          currentRevision: { include: { file: true } },
          revisions: { orderBy: { revNo: "desc" }, take: 1 },
        },
      }),
    );
    guard(letters.length === 2);
    for (const letter of letters) {
      const revision = letter.currentRevision,
        file = revision?.file;
      guard(
        revision &&
          file &&
          revision.id === letter.revisions[0]?.id &&
          revision.renderStatus === "ready" &&
          revision.signMode === "platform_cert" &&
          revision.certIssuer &&
          revision.certSerial &&
          revision.platformSignedAt &&
          revision.pdfSha256 &&
          file.status === "stored" &&
          file.category === "legal_doc" &&
          file.bucket === "secure" &&
          file.entityId === scope.entityId &&
          file.storeId === null &&
          file.sha256 === revision.pdfSha256,
      );
      const read = await runtime.providers.storage.readObject({
        bucket: "secure",
        key: file.objectKey,
        maxBytes: 1048576,
      });
      guard(
        read.ok &&
          Buffer.from(read.value.subarray(0, 5)).toString() === "%PDF-" &&
          createHash("sha256").update(read.value).digest("hex") === revision.pdfSha256,
      );
    }
    const ready = await runtime.tx.run((tx) =>
      runtime.licenseLetters.ensureLicenseReadiness(
        tx,
        [scope.itemId],
        `guard-w608-verify-${scope.runId}`,
      ),
    );
    guard(ready.length === 1 && ready[0]?.ready);
    process.stdout.write(
      `${JSON.stringify({ ticketId: scope.ticketId, orderItemId: scope.itemId, ready: true, rendered: revisions.length, letters: letters.length, signMode: "platform_cert", technicalTestCertificate: true })}\n`,
    );
  } finally {
    await runtime.close();
    await rendering?.close();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ evt: "w608.bridge.failed", phase, symbol: isAppError(error) ? error.error : "non_application" })}\n`,
  );
  process.stderr.write("W608本轮真实PDF准备拒绝或失败\n");
  process.exitCode = 1;
});
