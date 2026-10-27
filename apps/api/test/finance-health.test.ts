import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, uuidv7 } from "@liyoxi/services";
import { merchantCertificateForTest } from "@liyoxi/services/testing";
import { afterAll, expect, it } from "vitest";
import { useTestApi } from "../src/testing/index.js";

const testApi = useTestApi();
const directory = mkdtempSync(join(tmpdir(), "lyx-finance-health-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("hooks.internalHealth.finance.get：实际FILE证书与真实运行事实得到200，GET不写业务", async () => {
  const certificate = merchantCertificateForTest();
  const path = join(directory, "public-test-wechat-pay.json");
  writeFileSync(
    path,
    JSON.stringify({
      mchid: "1900000109",
      merchantSerialNo: certificate.serial,
      merchantPrivateKeyPem: certificate.privateKeyPem,
      merchantCertificatePem: certificate.certificatePem,
      apiV3Key: "public-test-key".padEnd(32, "0"),
      publicKeyId: "PUB_KEY_ID_TESTPAY",
      publicKeyPem: certificate.publicKeyPem,
      appid: "wx0000000000000000",
      notifyUrl: "https://example.invalid/hooks/wechatpay",
    }),
  );
  const configured = loadEnv({
    APP_ENV: "test",
    DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/liyoxi",
    REDIS_URL: "redis://127.0.0.1:6389/0",
    WECHAT_PAY_FILE: path,
  }).WECHAT_PAY!;
  const { request, clock } = await testApi.start({ wechatPayConfig: configured });
  const prisma = await testApi.db.prisma(),
    now = clock.now();
  await prisma.$executeRaw`
    INSERT INTO worker_lease(name,holder,holder_version,acquired_at,heartbeat_at)
    VALUES('primary','finance-api:test','test',clock_timestamp(),clock_timestamp())`;
  await prisma.invariantRun.create({
    data: {
      id: uuidv7(),
      mode: "full",
      trigger: "schedule",
      status: "succeeded",
      startedAt: new Date(now.getTime() - 60_000),
      finishedAt: now,
      checksRun: 1,
    },
  });
  await prisma.timer.create({
    data: {
      id: uuidv7(),
      kind: "billing.sweep.daily",
      dedupeKey: "billing.sweep.daily:public-health-test",
      fireAt: now,
      firedAt: now,
      status: "fired",
    },
  });
  const snapshot = () =>
    Promise.all([
      prisma.paymentTxn.count(),
      prisma.billingOrder.count(),
      prisma.auditLog.count(),
      prisma.outboxEvent.count(),
      prisma.timer.findMany({ orderBy: { id: "asc" } }),
      prisma.invariantRun.findMany({ orderBy: { id: "asc" } }),
    ]);
  const before = await snapshot();
  const response = await request("/internal/health/finance");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = (await response.json()) as {
    workerHeartbeatAgeSec: number;
    certificates: { daysLeft: number }[];
  };
  expect(body).toMatchObject({
    status: "ok",
    breaches: [],
    unappliedReceipt: { count: 0, oldestAgeSec: null },
    timerLagSec: 0,
    webhookBacklog: { pendingCount: 0, deadCount: 0, oldestPendingAgeSec: null },
    certificates: [{ kind: "merchant_api_cert", expiresAt: "2046-01-01T00:00:00.000Z" }],
    billing: {
      sweepLagSec: 0,
      invariantRunAgeSec: 0,
      openViolationCount: 0,
      valuationAgeSec: 0,
      oldestBlockedFulfillmentSec: 0,
    },
  });
  expect(body.workerHeartbeatAgeSec).toBeGreaterThanOrEqual(0);
  expect(body.workerHeartbeatAgeSec).toBeLessThan(60);
  expect(body.certificates[0]!.daysLeft).toBeGreaterThan(30);
  for (const value of [certificate.serial, "BEGIN", "openid", "mchid", "entityId"])
    expect(JSON.stringify(body)).not.toContain(value);
  expect(await snapshot()).toEqual(before);
}, 60_000);
