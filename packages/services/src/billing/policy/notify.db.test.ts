import { beforeAll, describe, expect, it } from "vitest";
import type { PurchaseRule } from "@liyoxi/shared/purchase-policy";
import { uuidv7 } from "../../kernel/index.js";
import { createPaymentHarness, useSeededDatabase } from "../../testing/index.js";
import { getNotifyPurchaseMode } from "./index.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof createPaymentHarness>;
beforeAll(async () => {
  h = createPaymentHarness(await db.prisma());
}, 120_000);

async function policy(rules: PurchaseRule[], effectiveAt: Date, approved = true) {
  const proposer = await h.make.staff();
  const reviewer = await h.make.staff();
  const id = uuidv7();
  const request = await h.prisma.approvalRequest.create({
    data: {
      id: uuidv7(),
      kind: "finance_config_change",
      category: "approval",
      subjectType: "finance_config_revision",
      subjectId: id,
      status: approved ? "approved" : "pending",
      summarySnapshot: { title: "通知购买策略测试" },
      submitActorType: "staff",
      submitActorId: proposer.id,
      submitClient: "admin",
      requesterStaffId: proposer.id,
      submittedAt: effectiveAt,
      ...(approved ? { decidedAt: effectiveAt, decidedByStaffId: reviewer.id } : {}),
      dedupeKey: `notify-policy:${id}`,
      createdAt: effectiveAt,
      updatedAt: effectiveAt,
    },
  });
  await h.prisma.financeConfigRevision.create({
    data: {
      id,
      configKey: "purchase_policy",
      payload: { rules: rules.map(({ when, then }) => ({ when, then })) },
      changeNote: "通知购买策略真实读口测试",
      approvalRequestId: request.id,
      effectiveAt,
      createdAt: effectiveAt,
    },
  });
}

describe("通知购买策略的五平台当前事实", () => {
  it("读一次当前已批准配置；任一真实套餐交易的严格档均生效，devtools不冒充终端", async () => {
    const { entity } = await h.make.merchant();
    const other = await h.make.merchant();
    const now = h.clock.now();
    await policy(
      [
        { when: { platforms: ["devtools"] }, then: { mode: "hidden" } },
        { when: { platforms: ["ios"], types: ["plan_renew"] }, then: { mode: "offline_contract" } },
        {
          when: { platforms: ["mac"], entityIds: [entity.id], types: ["plan_upgrade"] },
          then: { mode: "hidden" },
        },
      ],
      now,
    );
    const before = await h.prisma.financeConfigRevision.count();
    expect(await h.tx.run((tx) => getNotifyPurchaseMode(tx, entity.id, now))).toBe("hidden");
    expect(await h.tx.run((tx) => getNotifyPurchaseMode(tx, other.entity.id, now))).toBe(
      "offline_contract",
    );
    expect(await h.prisma.financeConfigRevision.count()).toBe(before);
  });

  it("同一TX取fresh值；未来或未批准修订不生效，到点后重算", async () => {
    const { entity } = await h.make.merchant();
    const now = new Date(h.clock.now().getTime() + 1_000);
    await policy([], now);
    const later = new Date(now.getTime() + 1_000);
    await policy([{ when: {}, then: { mode: "hidden" } }], later, false);
    await policy(
      [{ when: { platforms: ["harmony"] }, then: { mode: "offline_contract" } }],
      new Date(later.getTime() + 1),
    );
    expect(await h.tx.run((tx) => getNotifyPurchaseMode(tx, entity.id, later))).toBe("in_app");
    expect(
      await h.tx.run((tx) => getNotifyPurchaseMode(tx, entity.id, new Date(later.getTime() + 1))),
    ).toBe("offline_contract");
  });

  it("保留首匹配与未知版本/金额语义，topup规则不假装套餐规则", async () => {
    const { entity } = await h.make.merchant();
    const now = new Date(h.clock.now().getTime() + 10_000);
    await policy(
      [
        { when: { versionRange: ">=1.0.0" }, then: { mode: "hidden" } },
        { when: { amountGteFen: 1 }, then: { mode: "hidden" } },
        { when: { types: ["topup"] }, then: { mode: "hidden" } },
        { when: {}, then: { mode: "in_app" } },
        { when: {}, then: { mode: "hidden" } },
      ],
      now,
    );
    expect(await h.tx.run((tx) => getNotifyPurchaseMode(tx, entity.id, now))).toBe("in_app");
  });
});
