// NOT_SHIPPED: private W513 P2 test composition, scoped to this checkout's current run only.
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPrismaClient } from "@liyoxi/db";
import { createRuntime } from "../src/runtime.js";
import { createLogger } from "../src/logger.js";
import { isAppError, systemClock } from "../src/kernel/index.js";
import { fakeKeyEnv } from "../src/testing/staff.js";
import { createM1LicenseRendering, M1_LICENSE_TEST_INPUTS } from "../src/testing/index.js";
import {
  parseW513AftersalesContext,
  assertW513AftersalesScope,
  prepareW513Aftersales,
  renderW513Aftersales,
  changeW513LicenseInput,
  readW513AftersalesProof,
  cleanupW513Aftersales,
} from "../src/testing/admin-live/w513-aftersales.js";

const root = fileURLToPath(new URL("../../../apps/admin/dist/tmp/", import.meta.url));
let phase = "context";
let step = "CONTEXT";
const safeReasons: Readonly<Record<string, string>> = {
  W513P2拒绝其他检出或轮次: "CONTEXT_SCOPE",
  W513P2运行范围不符: "RUN_SCOPE",
  "W513P2主体、门店或实际演员归属不符": "ACTOR_SCOPE",
  W513P2需要两笔独立真实订购: "ORDERS_MISSING",
  W513P2订单集合不符: "ORDERS_SCOPE",
  W513P2真实开工或冻结引用不符: "CAPTURE_SCOPE",
  "W513P2拒绝部分准备或额外订单，不复造替身": "PARTIAL_PREPARE",
  W513P2当前协议不一致: "AGREEMENT_CHANGED",
  W513P2缺少真实开工handler: "START_HANDLER_MISSING",
  W513P2开工timer载荷不符: "START_PAYLOAD",
  W513P2真实开工handler未完成: "START_NOT_FIRED",
  W513P2真实开工时间或状态不符: "START_STATE",
  W513P2真实账号或入账周期不符: "ACCOUNT_TERM",
};
async function closeResources(tasks: (Promise<unknown> | undefined)[]) {
  const closed = await Promise.allSettled(tasks);
  const failed = closed.find((row) => row.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
async function main() {
  if (
    process.env.APP_ENV !== "test" ||
    Object.keys(process.env).some((key) => key.endsWith("_FILE"))
  )
    throw new Error("W513P2只接受无密钥文件的本轮test环境");
  const { values } = parseArgs({
    options: {
      context: { type: "string" },
      action: { type: "string" },
    },
  });
  if (
    !values.context ||
    !values.action ||
    !["prepare", "render", "fail-render", "change-license-input", "inspect", "cleanup"].includes(
      values.action,
    )
  )
    throw new Error("W513P2需要本轮context和明确白名单动作");
  const contextPath = await realpath(values.context),
    info = await stat(contextPath);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("W513P2 context超出有界输入");
  const scope = parseW513AftersalesContext(
    JSON.parse(await readFile(contextPath, "utf8")),
    contextPath,
    root,
  );
  const env = {
      APP_ENV: "test" as const,
      LOG_LEVEL: "error" as const,
      DATABASE_URL: `postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/${scope.name}?options=-c%20role%3Dlyx_app`,
      REDIS_URL: "redis://127.0.0.1:6389/0",
      PORTAL_PUBLIC_ORIGIN: M1_LICENSE_TEST_INPUTS.portalPublicOrigin,
      MINIO: { endpoint: "http://127.0.0.1:9100", publicEndpoint: "http://127.0.0.1:9100" },
      ...fakeKeyEnv(),
    },
    renders = values.action === "render" || values.action === "fail-render";
  const faultFonts = resolve(root, `admin-live-${scope.runId}`, "w513-p2-unavailable-fonts");
  if (values.action === "fail-render") {
    const exists = await stat(faultFonts).then(
      () => true,
      (error: unknown) => {
        if ((error as { code?: unknown }).code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) throw new Error("W513P2字体故障输入目录必须确实不存在");
  }
  const rendering = renders
    ? createM1LicenseRendering(
        systemClock,
        values.action === "fail-render" ? faultFonts : undefined,
      )
    : undefined;
  phase = "runtime";
  step = "RUNTIME_ASSEMBLY";
  const runtime = createRuntime({
    entry: renders ? "worker" : "api",
    env,
    clock: systemClock,
    version: "lyxtest.w513_p2",
    redisKeyPrefix: scope.prefix,
    ...(rendering ? { licenseRendering: rendering } : {}),
    logger: createLogger({
      svc: renders ? "worker" : "api",
      env: "test",
      level: "error",
      version: "lyxtest.w513_p2",
      destination: process.stderr,
    }),
  });
  let db: ReturnType<typeof createPrismaClient> | undefined;
  try {
    step = "SCOPE_GUARD";
    await assertW513AftersalesScope(runtime, scope);
    phase = values.action;
    let result: unknown;
    switch (values.action) {
      case "prepare":
        step = "PREPARE_CLIENT";
        db = createPrismaClient({ connectionString: env.DATABASE_URL, max: 1 });
        result = await prepareW513Aftersales(runtime, db, scope, (current) => {
          step = current;
        });
        break;
      case "render":
        result = await renderW513Aftersales(runtime, scope);
        break;
      case "fail-render":
        result = await renderW513Aftersales(runtime, scope, true);
        break;
      case "change-license-input":
        result = await changeW513LicenseInput(runtime, scope);
        break;
      case "inspect":
        result = await readW513AftersalesProof(runtime, scope);
        break;
      case "cleanup":
        result = await cleanupW513Aftersales(runtime, scope);
        break;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await closeResources([runtime.close(), rendering?.close(), db?.$disconnect()]);
  }
}
main().catch((error: unknown) => {
  const ownReason =
    error instanceof Error && Object.hasOwn(safeReasons, error.message)
      ? safeReasons[error.message]
      : undefined;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const publicCode = typeof code === "string" && /^P[0-9]{4}$/.test(code) ? code : undefined;
  const name =
    error instanceof Error &&
    ["KernelViolation", "EnvError", "TypeError", "RangeError", "ZodError"].includes(error.name)
      ? error.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
      : undefined;
  const reason = [step, ownReason ?? publicCode ?? name].filter(Boolean).join("_");
  process.stderr.write(
    `${JSON.stringify({
      evt: "w513.aftersales.failed",
      phase,
      symbol: isAppError(error) ? error.error : "non_application",
      reason,
    })}\n`,
  );
  process.stderr.write("W513P2本轮真实准备或证明失败\n");
  process.exitCode = 1;
});
