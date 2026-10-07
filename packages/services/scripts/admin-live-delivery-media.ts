// 只在 W119B 本轮隔离 live 库，对已上传文件调用实际 promote 并后置固定 known MP4 事实。
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createRuntime } from "../src/runtime.js";
import { createLogger } from "../src/logger.js";
import { fakeKeyEnv } from "../src/testing/staff.js";
import {
  ArtifactSchema,
  DeliveryLiveScopeSchema,
  assertDeliveryScope,
  cleanupDeliveryFile,
  prepareDeliveryKnownMedia,
} from "../src/testing/admin-live/delivery-known-media.js";
const root = fileURLToPath(new URL("../../../apps/admin/dist/tmp/", import.meta.url));
async function main() {
  if (
    process.env.APP_ENV !== "test" ||
    Object.keys(process.env).some((key) => key.endsWith("_FILE"))
  )
    throw new Error("只接受无密钥文件的显式 test 环境");
  const { values } = parseArgs({
    options: {
      context: { type: "string" },
      "file-id": { type: "string" },
      "client-token": { type: "string" },
      artifact: { type: "string" },
      cleanup: { type: "boolean", default: false },
    },
  });
  if (!values.context) throw new Error("需要本轮 context");
  const file = await realpath(values.context);
  const context = JSON.parse(await readFile(file, "utf8")) as {
    fixtures?: { fixtures?: Record<string, { scope?: unknown }> };
  };
  const scope = DeliveryLiveScopeSchema.parse(
    context.fixtures?.fixtures?.["zz-delivery-flow"]?.scope,
  );
  if (
    file !== resolve(root, `admin-live-${scope.runId}`, "context.json") ||
    scope.name !== `lyx_test_admin_live_${scope.runId}` ||
    scope.prefix !== `lyx:test:admin_live_${scope.runId}:`
  )
    throw new Error("只接受本检出本轮 context");
  const artifact = ArtifactSchema.parse(values.artifact),
    fileId = z.string().uuid().parse(values["file-id"]),
    clientToken = z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .parse(values["client-token"]);
  const env = {
    APP_ENV: "test" as const,
    LOG_LEVEL: "error" as const,
    DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/${scope.name}?options=-c%20role%3Dlyx_app`,
    REDIS_URL: "redis://127.0.0.1:6389/0",
    ...fakeKeyEnv(),
  };
  assertDeliveryScope(env, scope);
  const runtime = createRuntime({
    entry: "api",
    env,
    version: "lyxtest.w119b_media",
    redisKeyPrefix: scope.prefix,
    logger: createLogger({
      svc: "api",
      env: "test",
      level: "error",
      version: "lyxtest.w119b_media",
      destination: process.stderr,
    }),
  });
  try {
    const input = { scope, artifact, fileId, clientToken };
    const result = values.cleanup
      ? await cleanupDeliveryFile(runtime, input)
      : await prepareDeliveryKnownMedia(runtime, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await runtime.close();
  }
}
main().catch(() => {
  process.stderr.write("W119B 窄桥拒绝或文件入库未完成\n");
  process.exitCode = 1;
});
