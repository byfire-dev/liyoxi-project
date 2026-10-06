import { beforeAll, describe, expect, it } from "vitest";
import { createBizNoIssuer, createIdentityContext } from "../kernel/index.js";
import { runDemoSeed } from "../demo-seed.js";
import {
  assembleForTest,
  createTestStaffAuth,
  sampleStaffContext,
  useSeededDatabase,
} from "../testing/index.js";
import { proposeFinanceConfig } from "./finance-config/index.js";
import { createApproval } from "../approval/index.js";
import { createEvents } from "../events/index.js";
import { seedPlaceholderFinanceConfig } from "./demo-seed.js";
import { purchaseInvariants } from "./payment/purchase-registration.js";
const db = useSeededDatabase("services"),
  slow = 180_000;
let prisma: Awaited<ReturnType<typeof db.prisma>>,
  t: ReturnType<typeof createTestStaffAuth>,
  assembly: ReturnType<typeof assembleForTest>;
beforeAll(async () => {
  prisma = await db.prisma();
  t = createTestStaffAuth(prisma);
  assembly = assembleForTest({ entry: "worker" });
}, slow);
describe("占位受控财务配置正常双人审批", () => {
  it(
    "运行器固定步骤与真实 active 无口令财务可审批；三键生效且重复执行零新增",
    async () => {
      const deps = {
        tx: t.tx,
        clock: t.clock,
        keyring: t.keyring,
        flow: t.flow,
        appEnv: "test" as const,
        billing: { assembly, bizNo: createBizNoIssuer({ clock: t.clock, appEnv: "test" }) },
      };
      const first = await runDemoSeed(deps),
        again = await runDemoSeed(deps);
      expect(first.tables.find((s) => s.step === "billing")).toMatchObject({ inserted: 3 });
      expect(again.inserted).toBe(0);
      const rows = await prisma.financeConfigRevision.findMany({
        include: { approvalRequest: true },
      });
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.approvalRequest.status).toBe("approved");
        expect(r.approvalRequest.decidedByStaffId).not.toBe(r.approvalRequest.requesterStaffId);
        expect(r.effectiveAt!.getTime() - r.approvalRequest.decidedAt!.getTime()).toBe(
          r.configKey === "bank_account" ? 86_400_000 : 0,
        );
        expect(r.effectiveAt! <= t.clock.now()).toBe(true);
      }
      const bank = rows.find((r) => r.configKey === "bank_account")!;
      expect(bank.accountNoEnc).not.toContain("0000000000000000");
      expect(JSON.stringify(bank.payload)).not.toContain('"accountNo"');
      expect(bank.accountNoMask).toBeTruthy();
      for (const c of purchaseInvariants)
        expect(await t.tx.run((tx) => c.run!(tx, {}, { now: t.clock.now() }))).toEqual([]);
      const finance = first.staff.find((s) => s.key === "finance")!,
        lead = first.staff.find((s) => s.key === "finance_lead")!;
      await prisma.staff.update({
        where: { id: finance.staffId },
        data: {
          status: "disabled",
          disabledAt: t.clock.now(),
          disabledReason: "测试停用",
          disabledByStaffId: lead.staffId,
        },
      });
      await expect(
        seedPlaceholderFinanceConfig(
          { ...deps, ...deps.billing },
          { proposerId: finance.staffId, approverId: lead.staffId },
        ),
      ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
      expect(
        (await prisma.staff.findUniqueOrThrow({ where: { id: finance.staffId } })).status,
      ).toBe("disabled");
    },
    slow,
  );
  it(
    "提议权限、同键在途去重、自批拒绝与只有批准才能写生效时刻",
    async () => {
      const staff = await prisma.staff.findFirstOrThrow({
          where: { staffRoleKey: "finance", status: "active" },
        }),
        ctx = createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
        sc = await sampleStaffContext(prisma, staff.id, { stepUpAt: t.clock.now() }),
        bizNo = createBizNoIssuer({ clock: t.clock, appEnv: "test" }),
        events = createEvents({ assembly, clock: t.clock, tx: t.tx }),
        approval = createApproval({ assembly, clock: t.clock, flow: t.flow, events, bizNo }),
        deps = { approval, clock: t.clock, keyring: t.keyring },
        input = {
          configKey: "controls" as const,
          payload: {
            adminCreateOrder: false,
            wechatSingleLimitFen: 0,
            wechatDailyLimitFen: 0,
            receiptSecondReviewFen: null,
            shippingReport: false,
          },
          changeNote: "测试正常审批",
        };
      await expect(
        t.tx.run((tx) => proposeFinanceConfig(tx, deps, ctx, input, { ...sc, stepUpAt: null })),
      ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
      const proposal = await t.tx.run((tx) => proposeFinanceConfig(tx, deps, ctx, input, sc));
      await expect(
        t.tx.run((tx) => proposeFinanceConfig(tx, deps, ctx, input, sc)),
      ).rejects.toMatchObject({ error: "APPROVAL_ALREADY_PENDING" });
      await expect(
        t.tx.run((tx) =>
          approval.approve(tx, ctx, { approvalId: proposal.approvalId, staff: sc, lockVersion: 0 }),
        ),
      ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
      expect(
        (
          await prisma.financeConfigRevision.findUniqueOrThrow({
            where: { id: proposal.financeConfigRevisionId },
          })
        ).effectiveAt,
      ).toBeNull();
      await prisma.financeConfigRevision.update({
        where: { id: proposal.financeConfigRevisionId },
        data: { effectiveAt: t.clock.now() },
      });
      expect(
        await t.tx.run((tx) => purchaseInvariants[0]!.run!(tx, {}, { now: t.clock.now() })),
      ).toMatchObject([{ subject: { id: proposal.financeConfigRevisionId } }]);
    },
    slow,
  );
});
