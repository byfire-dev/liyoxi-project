// 验收第 5 条（任务书 W1-06 第 7 节；甲类的性质测试）：对随机的提交、通过、驳回、撤回序列，
//   ① 终态不再变；② 审批人 ≠ 发起人；③ 迁移数 = 状态历史行数 = 审计行数 = 事件数，决定数 = 回调次数；
//   ④ 每一步的结果（成功，或哪个错误码）与只按规则推的模型一致。
// 每一轮在真库里对同一个主体发一串操作：操作人从发起人、另一位财务、没有权限点的客服、系统里随机取。
// 种子与轮次固定，可用环境变量改：
//   LYX_FC_RUNS=2000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/approval/lifecycle.property.test.ts
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { isAppError } from "../kernel/index.js";
import type { IdentityContext } from "../kernel/index.js";
import { sampleSystemContext } from "../testing/index.js";

import { SLOW, useApprovalWorld } from "./__fixtures__/world.js";
import type { Merchant, Person } from "./__fixtures__/world.js";

const RUNS = Number(process.env["LYX_FC_RUNS"] ?? 200);
const SEED = Number(process.env["LYX_FC_SEED"] ?? 20261006);

const world = useApprovalWorld();
let requester: Person;
let finance: Person;
let cs: Person;
let merchant: Merchant;
const system = sampleSystemContext("lyxtest.approval.lifecycle");

beforeAll(async () => {
  // 发起人自己也持决定权限点：这样“发起人审批”拦的是发起人这一条，不是权限
  [requester, finance, cs] = await Promise.all([
    world.person(),
    world.person(),
    world.person({ role: "cs" }),
  ]);
  merchant = await world.merchant();
}, SLOW);

const ACTORS = ["requester", "finance", "cs", "system"] as const;
type ActorName = (typeof ACTORS)[number];
type Op = { op: "submit" } | { op: "approve" | "reject" | "withdraw"; by: ActorName };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Op>({ op: "submit" }) },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constantFrom("approve" as const, "reject" as const, "withdraw" as const),
      by: fc.constantFrom(...ACTORS),
    }),
  },
);

const TERMINAL = { approve: "approved", reject: "rejected", withdraw: "withdrawn" } as const;

/** 模型：这一步该成功，还是该回哪个错误码。只看规则，不看库 */
function expected(op: Exclude<Op, { op: "submit" }>, pending: boolean): string {
  if (!pending) return "APPROVAL_NOT_PENDING";
  if (op.by === "system") return "ok";
  if (op.op === "withdraw") return op.by === "requester" ? "ok" : "APPROVAL_WITHDRAW_FORBIDDEN";
  if (op.by === "requester") return "APPROVAL_SELF_FORBIDDEN";
  return op.by === "finance" ? "ok" : "PERMISSION_DENIED";
}

async function outcome(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
    return "ok";
  } catch (error) {
    if (isAppError(error)) return error.error;
    throw error;
  }
}

describe("审批单的迁移与留痕（验收 5）", () => {
  it(
    `随机序列 ${String(RUNS)} 轮（种子 ${String(SEED)}）：终态不再变，审批人不是发起人，迁移、历史、审计、事件、回调的数目对得上`,
    async () => {
      const { sample, input, prisma } = world;
      const people = { requester, finance, cs };
      const identityOf = (by: ActorName): IdentityContext =>
        by === "system" ? system : people[by].identity;
      let transitions = 0;
      let refused = 0;

      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 4 }), async (ops) => {
          // 每一轮的第一步都是提交；之后的 submit 在途时该被去重挡住，终态之后是新的一张
          const ids: string[] = [];
          let current: { id: string; status: string; lockVersion: number } | null = null;
          let submits = 0;
          let decisions = 0;
          for (const op of [{ op: "submit" } as Op, ...ops]) {
            const pending = current?.status === "pending";
            if (op.op === "submit") {
              const attempt = sample.submit(requester.identity, input.pointsAdjust(merchant));
              if (pending) {
                expect(await outcome(attempt)).toBe("APPROVAL_ALREADY_PENDING");
                refused += 1;
              } else {
                const submitted = await attempt;
                current = { id: submitted.approvalId, status: "pending", lockVersion: 0 };
                ids.push(submitted.approvalId);
                submits += 1;
              }
              continue;
            }
            if (current === null) throw new Error("第一步一定是提交");
            const base = {
              approvalId: current.id,
              ...(op.by === "system" ? {} : { staff: people[op.by].staff }),
            };
            const ctx = identityOf(op.by);
            const attempt =
              op.op === "approve"
                ? sample.approve(ctx, { ...base, lockVersion: current.lockVersion })
                : op.op === "reject"
                  ? sample.reject(ctx, { ...base, note: "样例：驳回" })
                  : sample.withdraw(ctx, base);
            const want = expected(op, pending);
            expect(await outcome(attempt), JSON.stringify(op)).toBe(want);
            if (want === "ok") {
              current = {
                ...current,
                status: TERMINAL[op.op],
                lockVersion: current.lockVersion + 1,
              };
              decisions += 1;
            } else {
              refused += 1;
            }
            // ① 终态不再变（被拒的操作也不改状态）：每一步之后库里的状态都等于模型的
            const row = await prisma.approvalRequest.findUniqueOrThrow({
              where: { id: current.id },
              select: { status: true, lockVersion: true },
            });
            expect(row).toEqual({ status: current.status, lockVersion: current.lockVersion });
          }

          // ②③ 这一轮建的各张单合起来核对
          const rows = await prisma.approvalRequest.findMany({ where: { id: { in: ids } } });
          for (const row of rows) {
            expect(
              row.decidedByStaffId === null || row.decidedByStaffId !== row.requesterStaffId,
            ).toBe(true);
          }
          const traces = await Promise.all(ids.map((id) => sample.trace(id)));
          const sum = (pick: (trace: (typeof traces)[number]) => number): number =>
            traces.reduce((total, trace) => total + pick(trace), 0);
          expect(sum((trace) => trace.transitions)).toBe(submits + decisions);
          expect(sum((trace) => trace.audits)).toBe(submits + decisions);
          expect(sum((trace) => trace.events.length)).toBe(submits + decisions);
          expect(
            sum(
              (trace) =>
                (trace.domain?.approved ?? 0) +
                (trace.domain?.rejected ?? 0) +
                (trace.domain?.withdrawn ?? 0),
            ),
          ).toBe(decisions);
          transitions += submits + decisions;

          // 收尾：留着在途的单会挡住下一轮的提交
          if (current?.status === "pending")
            await sample.withdraw(system, { approvalId: current.id });
        }),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
      process.stdout.write(
        `[approval 性质] 种子 ${String(SEED)}，${String(RUNS)} 轮：成功迁移 ${String(transitions)} 次，被拒 ${String(refused)} 次\n`,
      );
    },
    SLOW * 3,
  );
});
