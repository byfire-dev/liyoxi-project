import { expect, it, vi } from "vitest";
import { createRuntime, loadEnv } from "@liyoxi/services";
import {
  createRefundHarnessForTest,
  fakeKeyEnv,
  signInAsStaff,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
} from "@liyoxi/services/testing";
import { runRefundAbandonTxnCommand } from "../src/cli/refund-abandon-txn-command.js";

const db = useSeededDatabase("worker", { label: "refundcli", max: 1 });
async function* stdin(value: unknown) {
  yield JSON.stringify(value);
}

it("参数/非JSON/取消先拒绝且不创建运行时，凭据与正文不回显", async () => {
  const runtime = vi.fn(() => {
    throw new Error("禁止触及环境");
  });
  const controller = new AbortController();
  controller.abort();
  for (const options of [
    { argv: ["--finance-session", "fictional-secret"], stdin: stdin({}) },
    {
      argv: [],
      stdin: (async function* () {
        yield "not-json-fictional-secret";
      })(),
    },
    { argv: [], stdin: stdin({ financeSession: "fictional-secret" }), signal: controller.signal },
  ]) {
    const output: string[] = [];
    expect(
      await runRefundAbandonTxnCommand({
        ...options,
        runtime,
        out: (s) => output.push(s),
        err: (s) => output.push(s),
      }),
    ).toBe(1);
    expect(output.join("\n")).not.toContain("fictional-secret");
  }
  expect(runtime).not.toHaveBeenCalled();
});

it("真实stdin运输认证两份opaque会话，错误凭证零资金写；双人成功永久凭证且运行时收口", async () => {
  const h = createRefundHarnessForTest(await db.prisma());
  try {
    const r = await h.approved();
    await h.execute(r);
    const txn = await h.prisma.refundTxn.findFirstOrThrow({
      where: { refundRequestId: r.created.refundRequestId },
    });
    await h.result(txn.id, "ABNORMAL");
    const finance = await signInAsStaff(h.prisma, { roleKey: "finance", now: h.clock.now() }),
      administrator = await signInAsStaff(h.prisma, { roleKey: "super_admin", now: h.clock.now() });
    const file = await h.make.fileObject({
      category: "pay_receipt",
      bucket: "secure",
      scopeType: "entity",
      entityId: r.entity.id,
      uploadActorType: "staff",
      uploadActorId: finance.staff.id,
      uploadClient: "admin",
    });
    const input = {
      financeSession: finance.sessionToken,
      administratorSession: administrator.sessionToken,
      refundTxnId: txn.id,
      evidenceFileId: file.id,
      note: "渠道人工确认无法继续退款",
      financeConfirm: { requestNo: r.created.requestNo, outRefundNo: txn.outRefundNo },
      administratorConfirm: { requestNo: r.created.requestNo, outRefundNo: txn.outRefundNo },
    };
    const env = {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    };
    async function run(value: typeof input) {
      const output: string[] = [],
        errors: string[] = [];
      const runtime = createRuntime({
        entry: "worker",
        version: "w410-cli-test",
        env,
        clock: h.clock,
        billingKeyring: TEST_KEYRING,
        providers: h.provider,
      });
      const closed = vi.spyOn(runtime, "close");
      const code = await runRefundAbandonTxnCommand({
        argv: [],
        runtime: () => runtime,
        stdin: stdin(value),
        out: (s) => output.push(s),
        err: (s) => errors.push(s),
      });
      expect(closed).toHaveBeenCalledTimes(1);
      const text = [...output, ...errors].join("\n");
      expect(text).not.toContain(input.financeSession);
      expect(text).not.toContain(input.administratorSession);
      return { code, output, errors };
    }
    const tables = [
      "refund_request",
      "refund_txn",
      "payment_txn",
      "billing_order",
      "ledger_operation",
      "point_ledger_entry",
      "file_ref",
      "audit_log",
      "outbox_event",
    ];
    const before = await snapshotTables(h.prisma, tables);
    const rejected = await run({ ...input, administratorSession: "fictional-invalid-cookie" });
    expect(rejected).toMatchObject({ code: 1, output: [] });
    expect(rejected.errors).toEqual(["退款放弃拒绝：SESSION_INVALID"]);
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    const success = await run(input);
    expect(success).toMatchObject({ code: 0, errors: [] });
    expect(JSON.parse(success.output[0]!)).toMatchObject({
      refundTxnId: txn.id,
      status: "abandoned",
    });
    expect(
      await h.prisma.fileRef.findFirstOrThrow({
        where: { refType: "refund_txn", refId: txn.id, role: "abandon_evidence" },
      }),
    ).toMatchObject({ fileId: file.id, keepUntil: null, state: "live" });
  } finally {
    h.close();
  }
});
