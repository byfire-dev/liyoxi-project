// 验收第 6 条（任务书 W1-06 第 7 节）：在途去重、驳回后再提交与轮次、幂等重放不再调处理器、加锁顺序。
// 另：登记写错的在 createApproval 时一次报全；没登记的类型、不合结构的摘要按内部错误拒掉。
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBizNoIssuer,
  createIdempotencyContext,
  defineRegistration,
  implementKeyed,
  KernelViolation,
  lockRows,
  uuidv7,
} from "../kernel/index.js";
import {
  assembleForTest,
  createSampleApproval,
  SAMPLE_APPROVAL_KINDS,
  sampleSystemContext,
} from "../testing/index.js";

import { openClient, refusal, SLOW, useApprovalWorld } from "./__fixtures__/world.js";
import type { Person } from "./__fixtures__/world.js";
import { ApprovalError } from "./errors.js";
import { bindApprovalKinds, boundApprovalKinds } from "./invariants.js";
import { approvalKindPort } from "./kinds.js";
import type { ApprovalKindRegistration } from "./kinds.js";
import { approvalKindsOf, createApproval } from "./runtime.js";

const world = useApprovalWorld();
const T = { timeout: SLOW };
let second: PrismaClient;

beforeAll(async () => {
  second = await openClient(world.db);
}, SLOW);
afterAll(async () => {
  await second?.$disconnect();
});

const idemOf = (person: Person, key: string, body: unknown) =>
  createIdempotencyContext({
    mode: "required",
    scope: "lyxtest.approval.sample",
    actor: person.identity.actor,
    key,
    request: { method: "POST", body },
  });

describe("提交与在途去重（验收 6）", () => {
  it(
    "提交写下一张待审的单：摘要、单号、发起人与所在组的快照，一行历史、一行审计、一条事件",
    T,
    async () => {
      const { sample, input, prisma } = world;
      const groupId = await world.group("cs");
      const requester = await world.person({ role: "cs", groupId });
      const merchant = await world.merchant();
      const submitted = await sample.submit(requester.identity, {
        ...input.pointsAdjust(merchant),
        input: { title: "积分调整 +200" },
        idempotencyKey: "client-key-1",
      });
      expect(submitted).toMatchObject({ roundNo: 1, lockVersion: 0 });
      const row = await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: submitted.approvalId },
      });
      expect(row).toMatchObject({
        requestNo: submitted.requestNo,
        kind: "points_adjust",
        category: "approval",
        status: "pending",
        subjectId: merchant.entityId,
        storeId: null,
        submitActorType: "staff",
        submitActorId: requester.id,
        requesterStaffId: requester.id,
        requesterStaffGroupId: groupId,
        dedupeKey: `points_adjust:${merchant.entityId}`,
        idempotencyKey: "client-key-1",
        dueAt: null,
        slaSnapshot: null,
        summarySnapshot: {
          title: "积分调整 +200",
          lines: [{ label: "类型", value: "points_adjust" }],
          domain: { type: "lyx_sample_approval_domain", id: submitted.domainId },
        },
      });
      expect(await sample.trace(submitted.approvalId)).toMatchObject({
        transitions: 1,
        audits: 1,
        events: ["approval.submitted"],
      });
    },
  );

  it(
    "同对象第二张在途单：409 APPROVAL_ALREADY_PENDING，details 指向在审的那一张；决定之后可以再提交",
    T,
    async () => {
      const { sample, input } = world;
      const requester = await world.person({ role: "cs" });
      const finance = await world.person();
      const merchant = await world.merchant();
      const first = await sample.submit(requester.identity, input.pointsAdjust(merchant));
      const again = sample.submit(requester.identity, input.pointsAdjust(merchant));
      expect(await refusal(again)).toEqual({
        error: "APPROVAL_ALREADY_PENDING",
        details: { approvalId: first.approvalId, requestNo: first.requestNo },
      });
      await sample.reject(finance.identity, {
        approvalId: first.approvalId,
        staff: finance.staff,
        note: "依据不足",
      });
      const next = await sample.submit(requester.identity, input.pointsAdjust(merchant));
      expect(next.approvalId).not.toBe(first.approvalId);
      expect(next.requestNo).not.toBe(first.requestNo);
    },
  );

  it("审核驳回后再提交是新的一行，轮次由登记给出", T, async () => {
    const { sample, input, prisma } = world;
    const cs = await world.person({ role: "cs" });
    const merchant = await world.merchant();
    const first = await sample.submit(merchant.identity, input.qualification(merchant, 1));
    await sample.reject(cs.identity, {
      approvalId: first.approvalId,
      staff: cs.staff,
      note: "证照过期",
      reasonCodes: ["R03"],
    });
    const resubmitted = await sample.submit(merchant.identity, input.qualification(merchant, 2));
    expect(resubmitted).toMatchObject({ roundNo: 2, requestNo: null });
    const rows = await prisma.approvalRequest.findMany({
      where: { storeId: merchant.storeId, kind: "qualification" },
      orderBy: { roundNo: "asc" },
    });
    expect(rows.map((row) => [row.roundNo, row.status, row.dedupeKey])).toEqual([
      [1, "rejected", `qualification:${merchant.storeId}`],
      [2, "pending", `qualification:${merchant.storeId}`],
    ]);
  });

  it("两条连接同时为同一对象提交：恰一张进库，另一个回 APPROVAL_ALREADY_PENDING", T, async () => {
    const { sample, input, prisma } = world;
    const other = createSampleApproval(second);
    const requester = await world.person({ role: "cs" });
    for (let round = 0; round < 5; round += 1) {
      const merchant = await world.merchant();
      const results = await Promise.allSettled(
        [sample, other].map((side) =>
          side.submit(requester.identity, input.pointsAdjust(merchant)),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const failed = results.find((result) => result.status === "rejected");
      expect(failed?.reason).toMatchObject({ error: "APPROVAL_ALREADY_PENDING" });
      expect(await prisma.approvalRequest.count({ where: { entityId: merchant.entityId } })).toBe(
        1,
      );
    }
  });

  it("有执行步的类型不填去重键、取 TK 单号；系统代员工生成时发起人是那名员工", T, async () => {
    const { sample, input, prisma } = world;
    const requester = await world.person({ role: "cs" });
    const merchant = await world.merchant();
    const submitted = await sample.submit(sampleSystemContext("order.on_qualification_decided"), {
      ...input.orderCancel(merchant),
      requesterStaffId: requester.id,
    });
    expect(submitted.requestNo).toMatch(/^TK\d{11}$/);
    const row = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: submitted.approvalId },
    });
    expect(row).toMatchObject({
      dedupeKey: null,
      submitActorType: "system",
      submitActorId: null,
      submitClient: null,
      requesterStaffId: requester.id,
    });
    // 发起人仍然不能批它
    const self = sample.approve(requester.identity, {
      approvalId: submitted.approvalId,
      staff: requester.staff,
      lockVersion: 0,
    });
    expect((await refusal(self)).error).toBe("APPROVAL_SELF_FORBIDDEN");
  });

  it("validate 不过：原样抛出，什么都没写；摘要不合结构、类型没登记：内部错误", T, async () => {
    const { sample, input, prisma } = world;
    const requester = await world.person({ role: "cs" });
    const merchant = await world.merchant();
    const invalid = sample.submit(requester.identity, {
      ...input.pointsAdjust(merchant),
      input: { invalid: true },
    });
    expect((await refusal(invalid)).error).toBe("VALIDATION_FAILED");
    const badSummary = sample.submit(requester.identity, {
      ...input.pointsAdjust(merchant),
      input: { badSummary: true },
    });
    await expect(badSummary).rejects.toMatchObject({ name: "ApprovalError", reason: "summary" });
    // 退款类型已经实际登记；缺登记反例显式移除本实例的类型实现。
    const previousKinds = boundApprovalKinds();
    try {
      const missingKinds = createApproval({
        assembly: assembleForTest({ entry: "api", withoutRealPorts: [approvalKindPort] }),
        clock: sample.clock,
        flow: sample.flow,
        events: sample.events,
        bizNo: createBizNoIssuer({ clock: sample.clock, appEnv: "test" }),
      });
      expect(missingKinds.kinds.has("plan_refund")).toBe(false);
      const unregistered = sample.tx.run((tx) =>
        missingKinds.submit(tx, requester.identity, {
          kind: "plan_refund",
          subjectType: "billing_order",
          subjectId: uuidv7(),
          entityId: merchant.entityId,
          input: null,
        }),
      );
      await expect(unregistered).rejects.toMatchObject({
        name: "ApprovalError",
        reason: "unregistered",
      });
      expect(await prisma.approvalRequest.count({ where: { entityId: merchant.entityId } })).toBe(
        0,
      );
    } finally {
      bindApprovalKinds(previousKinds);
    }
  });
});

describe("幂等重放（验收 6）", () => {
  it("带幂等键的样例用例重放：返回存下的结果，不再提交、不再取号", T, async () => {
    const { sample, input, prisma } = world;
    const requester = await world.person({ role: "cs" });
    const merchant = await world.merchant();
    const body = { entityId: merchant.entityId };
    const key = uuidv7();
    const first = await sample.submit(requester.identity, input.pointsAdjust(merchant), {
      idem: idemOf(requester, key, body),
    });
    const replay = idemOf(requester, key, body);
    const again = await sample.submit(requester.identity, input.pointsAdjust(merchant), {
      idem: replay,
    });
    expect(replay.replayed).toBe(true);
    expect(again).toMatchObject({ approvalId: first.approvalId, requestNo: first.requestNo });
    expect(await prisma.approvalRequest.count({ where: { entityId: merchant.entityId } })).toBe(1);
    expect(await sample.trace(first.approvalId)).toMatchObject({ transitions: 1, audits: 1 });
  });

  it("带幂等键的通过重放：回调只执行 1 次，历史、审计、事件不多", T, async () => {
    const { sample, input } = world;
    const requester = await world.person({ role: "cs" });
    const finance = await world.person();
    const { approvalId } = await sample.submit(
      requester.identity,
      input.pointsAdjust(await world.merchant()),
    );
    const key = uuidv7();
    const approveOnce = (idem = idemOf(finance, key, { approvalId })) =>
      sample.tx
        .run(
          (tx) =>
            sample.approval.approve(tx, finance.identity, {
              approvalId,
              staff: finance.staff,
              lockVersion: 0,
            }),
          { idem },
        )
        .then((result) => ({ result, replayed: idem.replayed }));
    const first = await approveOnce();
    const second = await approveOnce();
    expect([first.replayed, second.replayed]).toEqual([false, true]);
    expect(second.result).toMatchObject({ approvalId, status: "approved", lockVersion: 1 });
    expect(await sample.trace(approvalId)).toMatchObject({
      transitions: 2,
      audits: 2,
      events: ["approval.submitted", "approval.approved"],
      domain: { approved: 1, revalidated: 1 },
    });
  });
});

describe("加锁顺序（验收 6）：员工行 20 → 审批单 30 → 领域行", () => {
  it(
    "照次序加锁的通过不违规；处理器回头去锁员工行、领域用例先锁了领域行再调进来，都被锁序断言拦下",
    T,
    async () => {
      const { sample, input, prisma } = world;
      const requester = await world.person({ role: "cs" });
      const finance = await world.person();
      const merchant = await world.merchant();
      // 样例的 onApproved 锁门店（130）：在员工行与审批单之后，不违规
      const ok = await sample.submit(requester.identity, input.orderCancel(merchant));
      await sample.approve(finance.identity, {
        approvalId: ok.approvalId,
        staff: finance.staff,
        lockVersion: 0,
      });
      expect((await sample.trace(ok.approvalId)).status).toBe("approved");

      // 领域用例先锁了门店再调 approve：员工行（20）排在门店之前，违规
      const late = await sample.submit(requester.identity, input.orderCancel(merchant));
      const domainFirst = sample.tx.run(async (tx) => {
        await lockRows(tx, "store", [merchant.storeId], "update");
        return sample.approval.approve(tx, finance.identity, {
          approvalId: late.approvalId,
          staff: finance.staff,
          lockVersion: 0,
        });
      });
      await expect(domainFirst).rejects.toThrow(KernelViolation);

      // 处理器在审批单之后回头锁别的员工行：违规
      const base = SAMPLE_APPROVAL_KINDS.order_cancel as ApprovalKindRegistration;
      const backwards = createSampleApproval(prisma, {
        kinds: {
          order_cancel: {
            ...base,
            onApproved: async (tx) => {
              await lockRows(tx, "staff", [requester.id], "share");
            },
          },
        },
      });
      const attempt = backwards.approve(finance.identity, {
        approvalId: late.approvalId,
        staff: finance.staff,
        lockVersion: 0,
      });
      await expect(attempt).rejects.toThrow(KernelViolation);
      expect(await sample.trace(late.approvalId)).toMatchObject({
        status: "pending",
        transitions: 1,
      });
    },
  );
});

describe("系统动作与锁序", () => {
  it(
    "提交后同一事务里免审批通过：中间锁了次序更大的行也不违规；归属模块先锁审批单再锁自己的行，最后以系统身份撤回",
    T,
    async () => {
      const { sample, input } = world;
      const requester = await world.person({ role: "cs" });
      const merchant = await world.merchant();
      const system = sampleSystemContext("cancel.auto_execute");
      const auto = await sample.tx.run(async (tx) => {
        const submitted = await sample.approval.submit(tx, requester.identity, {
          ...input.orderCancel(merchant),
          input: { domainId: uuidv7() },
        });
        await lockRows(tx, "store", [merchant.storeId], "update");
        return sample.approval.approve(tx, system, { approvalId: submitted.approvalId });
      });
      expect(await sample.trace(auto.approvalId)).toMatchObject({
        status: "approved",
        transitions: 2,
        audits: 2,
        events: ["approval.submitted", "approval.approved"],
      });

      const pending = await sample.submit(merchant.identity, input.channelAccount(merchant));
      await sample.tx.run(async (tx) => {
        await lockRows(tx, "approval_request", [pending.approvalId], "update");
        await lockRows(tx, "store", [merchant.storeId], "update");
        return sample.approval.withdraw(tx, sampleSystemContext("launch.void"), {
          approvalId: pending.approvalId,
        });
      });
      expect((await sample.trace(pending.approvalId)).status).toBe("withdrawn");
    },
  );
});

describe("登记的校验", () => {
  it("键不是审批类型、大类、执行步、去重键、单号前缀、表名写错：createApproval 时一次列全", () => {
    const base = SAMPLE_APPROVAL_KINDS.points_adjust as ApprovalKindRegistration;
    const assemblyOf = (kinds: Record<string, ApprovalKindRegistration>) =>
      assembleForTest({
        entry: "api",
        isolated: true,
        extra: [
          defineRegistration("lyxtest_kinds", {
            ports: [approvalKindPort],
            portImplementations: Object.entries(kinds).map(([key, kind]) =>
              implementKeyed(approvalKindPort, key, kind),
            ),
          }),
        ],
      });
    expect([...approvalKindsOf(assemblyOf({ points_adjust: base })).keys()]).toEqual([
      "points_adjust",
    ]);
    const broken = assemblyOf({
      lyxtest_invalid_kind: base,
      qualification: base,
      order_cancel: base,
      subscription_extend: {
        ...base,
        domain: { table: "Bad-Name", column: "approval_request_id" },
      },
      points_adjust: { ...base, viewModules: [] },
    });
    let thrown: unknown;
    try {
      approvalKindsOf(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApprovalError);
    const message = (thrown as Error).message;
    expect(message).toContain("审批类型的登记有 9 处不对");
    for (const part of [
      "lyxtest_invalid_kind：不是已声明的审批类型（approval_request.kind）",
      "qualification：大类应是 review",
      "qualification：单号前缀应是 null",
      "order_cancel：有执行步",
      "order_cancel：有执行步的类型不给在途去重键",
      "order_cancel：单号前缀应是 TK",
      "subscription_extend：单号前缀应是 YQ",
      "subscription_extend：领域表名或列名的写法不对",
      "points_adjust：没写查看所需的模块",
    ]) {
      expect(message).toContain(part);
    }
  });
});
