import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, expect, it } from "vitest";
import { createApproval } from "../approval/index.js";
import { proposeFinanceConfig } from "./index.js";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createBizNoIssuer, createIdentityContext } from "../kernel/index.js";
import { createTenant } from "../tenant/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createTestStaffAuth,
  sampleStaffContext,
  useSeededDatabase,
} from "../testing/index.js";
import { createIdentity } from "../identity/index.js";
import type { Identity } from "../identity/index.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T04:00:00Z"));
let prisma: PrismaClient, identity: Identity;
let h: ReturnType<typeof createTestStaffAuth>, make: ReturnType<typeof createFactories>;
let assembly: ReturnType<typeof assembleForTest>;
beforeAll(async () => {
  prisma = await db.prisma();
  h = createTestStaffAuth(prisma, { clock });
  assembly = assembleForTest({ entry: "api" });
  const events = createEvents({ assembly, clock, tx: h.tx });
  const flow = createFlow({ assembly, clock, events });
  make = createFactories({ db: prisma, clock });
  identity = createIdentity({
    tx: h.tx,
    clock,
    assembly,
    docs: createDocs({ tx: h.tx, clock }),
    tenant: createTenant({ tx: h.tx, clock, assembly, flow }),
    config: createConfig({ db: prisma, clock, redis: null }),
    flow,
    events,
    keyring: () => h.keyring,
    wechat: null,
    appid: "wxfixture",
  });
  for (const [slotKey, providerTemplateId] of Object.entries({
    review_result: "fixture-review",
    pay_result: "fixture-pay",
    svc_expiry: "fixture-expiry",
    quota_change: "fixture-quota",
  }))
    await prisma.wxTemplateSlot.update({
      where: { slotKey },
      data: { providerTemplateId, status: "active", fields: [], updatedAt: clock.now() },
    });
}, 120_000);
it("订阅策略读取真实已批准finance配置、首匹配/版本/可信entity与同一个受控clock", async () => {
  const merchant = await make.merchant(),
    foreign = await make.merchant();
  const proposer = await make.staff({ staffRoleKey: "finance" }),
    approver = await make.staff({ staffRoleKey: "finance", isLead: true });
  const events = createEvents({ assembly, clock, tx: h.tx });
  const approval = createApproval({
    assembly,
    clock,
    flow: h.flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });
  const proposerContext = await sampleStaffContext(prisma, proposer.id, { stepUpAt: clock.now() }),
    approverContext = await sampleStaffContext(prisma, approver.id, { stepUpAt: clock.now() });
  const created = await h.tx.run((tx) =>
    proposeFinanceConfig(
      tx,
      { clock, keyring: h.keyring, approval },
      createIdentityContext({ actor: { type: "staff", id: proposer.id, client: "admin" } }),
      {
        configKey: "purchase_policy",
        payload: {
          rules: [
            {
              when: {
                platforms: ["ios"],
                versionRange: ">=2.0.0",
                entityIds: [merchant.entity.id],
              },
              then: { mode: "hidden" },
            },
            { when: { platforms: ["ios"] }, then: { mode: "offline_contract" } },
          ],
        },
        changeNote: "隔离测试购买策略",
      },
      proposerContext,
    ),
  );
  const input = {
    merchantUserId: merchant.user.id,
    storeId: merchant.store.id,
    platform: "ios",
    clientVersion: "2.0.0",
  };
  expect(
    (await identity.bootstrap(input)).subscribePlan?.some((point) => point.point === "pay_success"),
  ).toBe(true);
  await h.tx.run((tx) =>
    approval.approve(
      tx,
      createIdentityContext({ actor: { type: "staff", id: approver.id, client: "admin" } }),
      {
        approvalId: created.approvalId,
        staff: approverContext,
        lockVersion: 0,
        meta: { requestId: null, ip: null, userAgent: null, authMethod: null, sessionId: null },
      },
    ),
  );
  const hidden = await identity.bootstrap(input);
  expect(
    hidden.subscribePlan?.some(
      (point) => point.point === "pay_success" || point.point === "renew_enter",
    ),
  ).toBe(false);
  expect(
    hidden.subscribePlan
      ?.flatMap((point) => point.slots)
      .some((slot) => slot.slotKey === "quota_change"),
  ).toBe(false);
  const untrusted = await identity.bootstrap({ ...input, storeId: foreign.store.id });
  expect(
    untrusted.subscribePlan
      ?.flatMap((point) => point.slots)
      .some((slot) => slot.slotKey === "quota_change"),
  ).toBe(true);
  const oldVersion = await identity.bootstrap({ ...input, clientVersion: "1.0.0" });
  expect(
    oldVersion.subscribePlan
      ?.flatMap((point) => point.slots)
      .some((slot) => slot.slotKey === "quota_change"),
  ).toBe(true);
  const android = await identity.bootstrap({ ...input, platform: "android" });
  expect(android.subscribePlan?.some((point) => point.point === "pay_success")).toBe(true);
}, 120_000);
