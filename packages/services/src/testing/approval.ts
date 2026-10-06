// 审批的样例（W1-06）：样例审批类型的登记与样例领域用例，只给测试用，不进生产装配。
// 真实的类型由各域登记（qualification 归 W1-08，channel_account、launch_link 归 W1-14……）；这里借用五个真实的 kind 取值
// （库的 CHECK 只收那 12 个），处理器是假的：领域行在一张探针表 lyx_sample_approval_domain 上（不在迁移里，测试库里现建），
// 各列记处理器被调了几次，用例据此断言“回调只执行 1 次”。
//
//   points_adjust        员工发起、通过即生效、有单号 TZ；财务审批
//   subscription_extend  员工发起、仅限发起人所在组的主管审批、有单号 YQ
//   qualification        商家提交的审核，轮次由登记给出
//   channel_account      商家提交的审核，角色队列（不套数据范围）
//   order_cancel         有执行步：通过后停在 approved，执行是另一个事务
import type { ApprovalKind } from "@liyoxi/contract";
import type { Prisma, PrismaClient } from "@liyoxi/db";

import { approvalKindPort, createApproval, defineApprovalKind } from "../approval/index.js";
import type {
  Approval,
  ApprovalKindRegistration,
  ApprovalRow,
  ApproveInput,
  DecisionResult,
  RejectInput,
  SubmitInput,
  SubmitResult,
  WithdrawInput,
} from "../approval/index.js";
import { buildStaffContext, isStaffRoleKey, normalizeRoleConfig } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { createEvents } from "../events/index.js";
import type { EmitContext, Events } from "../events/index.js";
import { createFlow, workMinutesPort } from "../flow/index.js";
import type { Flow } from "../flow/index.js";
import {
  AppError,
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  defineRegistration,
  implement,
  implementKeyed,
  lockRows,
  uuidv7,
} from "../kernel/index.js";
import type {
  Assembly,
  IdempotencyContext,
  IdentityContext,
  ModuleRegistration,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import { assembleForTest } from "./assembly.js";
import { createClock } from "./clock.js";
import type { AdjustableClock } from "./clock.js";
import { fixedWorkMinutes } from "./flow.js";

export const SAMPLE_APPROVAL_TABLE = "lyx_sample_approval_domain";

/** 建探针表并授权给应用角色。要属主身份的连接（connectTestDatabase(库名, { role: null })）；可重复执行 */
export const SAMPLE_APPROVAL_DDL = `
  CREATE TABLE IF NOT EXISTS ${SAMPLE_APPROVAL_TABLE} (
    id uuid PRIMARY KEY,
    approval_request_id uuid,
    status text NOT NULL,
    close_reason text,
    revalidated integer NOT NULL DEFAULT 0,
    approved integer NOT NULL DEFAULT 0,
    rejected integer NOT NULL DEFAULT 0,
    withdrawn integer NOT NULL DEFAULT 0,
    executed integer NOT NULL DEFAULT 0
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON ${SAMPLE_APPROVAL_TABLE} TO lyx_app;`;

/** 样例领域用例随提交传给处理器的东西 */
export interface SampleApprovalInput {
  /** 领域行的 id：不给即现取 */
  readonly domainId?: string;
  readonly title?: string;
  /** 第几轮（qualification 的登记取它） */
  readonly roundNo?: number;
  /** 让 validate 拒掉 */
  readonly invalid?: boolean;
  /** 让摘要带上登记之外的键（内部错误） */
  readonly badSummary?: boolean;
}

/** 随决定传给处理器的东西 */
export interface SampleDecisionArgs {
  /** 让 revalidate 认为前提已变 */
  readonly changed?: boolean;
  /** 处理器里先调它一下（并发用例拿它对齐栅栏、别的用例拿它数次数） */
  readonly probe?: () => void | Promise<void>;
}

export interface SampleDomainRow {
  id: string;
  approvalRequestId: string | null;
  status: string;
  closeReason: string | null;
  revalidated: number;
  approved: number;
  rejected: number;
  withdrawn: number;
  executed: number;
}

type SampleSubmission = Parameters<ApprovalKindRegistration<SampleApprovalInput>["validate"]>[1];
const domainIdOf = (submission: SampleSubmission): string => {
  const id = submission.input.domainId;
  if (id === undefined) throw new TypeError("样例提交要带 input.domainId");
  return id;
};
const argsOf = (args: unknown): SampleDecisionArgs => (args ?? {}) as SampleDecisionArgs;

/** 领域行由处理器自己锁：样例锁门店（130）或主体（100），都排在审批单（30）之后 */
async function lockDomainSide(tx: Tx, row: ApprovalRow): Promise<void> {
  if (row.storeId !== null) await lockRows(tx, "store", [row.storeId], "share");
  else if (row.entityId !== null) await lockRows(tx, "entity", [row.entityId], "share");
}

type Common = Pick<
  ApprovalKindRegistration<SampleApprovalInput>,
  | "domain"
  | "operations"
  | "validate"
  | "summarize"
  | "revalidate"
  | "onApproved"
  | "onRejected"
  | "onWithdrawn"
>;

function handlers(kind: ApprovalKind, hasExecution: boolean): Common {
  const close = (column: "rejected" | "withdrawn") => async (tx: Tx, row: ApprovalRow) => {
    await lockDomainSide(tx, row);
    await tx.$executeRawUnsafe(
      `UPDATE ${SAMPLE_APPROVAL_TABLE}
          SET ${column} = ${column} + 1, status = 'not_executed', close_reason = $2
        WHERE approval_request_id = $1::uuid`,
      row.id,
      column,
    );
  };
  return {
    domain: { table: SAMPLE_APPROVAL_TABLE, column: "approval_request_id" },
    operations: {
      get: `lyxtest.${kind}.get`,
      approve: `lyxtest.${kind}.approve`,
      reject: `lyxtest.${kind}.reject`,
      withdraw: `lyxtest.${kind}.withdraw`,
    },
    validate: (_tx, submission) =>
      submission.input.invalid === true
        ? Promise.reject(new AppError("VALIDATION_FAILED", { message: "样例：提交前校验不过" }))
        : Promise.resolve(),
    summarize: (_tx, submission) =>
      Promise.resolve({
        title: submission.input.title ?? `样例申请 ${kind}`,
        lines: [{ label: "类型", value: kind }],
        domain: { type: SAMPLE_APPROVAL_TABLE, id: domainIdOf(submission) },
        ...(submission.input.badSummary === true ? { certNo: "明文不该进摘要" } : {}),
      }),
    async revalidate(tx, row, args) {
      await tx.$executeRawUnsafe(
        `UPDATE ${SAMPLE_APPROVAL_TABLE} SET revalidated = revalidated + 1
          WHERE approval_request_id = $1::uuid`,
        row.id,
      );
      if (argsOf(args).changed === true) throw new AppError("PRECONDITION_CHANGED");
    },
    async onApproved(tx, row, decision) {
      await lockDomainSide(tx, row);
      await tx.$executeRawUnsafe(
        `UPDATE ${SAMPLE_APPROVAL_TABLE} SET approved = approved + 1, status = $2
          WHERE approval_request_id = $1::uuid`,
        row.id,
        hasExecution ? "pending_execution" : "applied",
      );
      await argsOf(decision.args).probe?.();
    },
    onRejected: close("rejected"),
    onWithdrawn: close("withdrawn"),
  };
}

/** 五个样例类型的登记，键是 kind */
export const SAMPLE_APPROVAL_KINDS: Readonly<
  Partial<Record<ApprovalKind, ApprovalKindRegistration>>
> = {
  points_adjust: defineApprovalKind<SampleApprovalInput>({
    ...handlers("points_adjust", false),
    category: "approval",
    viewModules: ["finance", "billing"],
    decidePermission: "billing.adjust.approve",
    groupBound: false,
    hasExecution: false,
    numberPrefix: "TZ",
    dedupeKey: (submission) => `points_adjust:${String(submission.entityId)}`,
  }),
  subscription_extend: defineApprovalKind<SampleApprovalInput>({
    ...handlers("subscription_extend", false),
    category: "approval",
    viewModules: ["order", "billing"],
    decidePermission: "billing.extension.approve",
    groupBound: true,
    hasExecution: false,
    numberPrefix: "YQ",
    dedupeKey: (submission) => `subscription_extend:${String(submission.entityId)}`,
  }),
  qualification: defineApprovalKind<SampleApprovalInput>({
    ...handlers("qualification", false),
    category: "review",
    viewModules: ["merchant"],
    decidePermission: "merchant.qualification.review",
    groupBound: false,
    hasExecution: false,
    numberPrefix: null,
    dedupeKey: (submission) => `qualification:${String(submission.storeId)}`,
    roundNo: (_tx, submission) => Promise.resolve(submission.input.roundNo ?? 1),
  }),
  channel_account: defineApprovalKind<SampleApprovalInput>({
    ...handlers("channel_account", false),
    category: "review",
    viewModules: ["publish"],
    decidePermission: "publish.account.verify",
    groupBound: false,
    roleQueue: true,
    hasExecution: false,
    numberPrefix: null,
    dedupeKey: (submission) => `channel_account:${submission.subjectId}`,
  }),
  order_cancel: defineApprovalKind<SampleApprovalInput>({
    ...handlers("order_cancel", true),
    category: "approval",
    viewModules: ["order", "finance"],
    decidePermission: "finance.refund.approve",
    groupBound: false,
    hasExecution: true,
    numberPrefix: "TK",
  }),
};

/** 样例登记：审批类型按端口登记进去；工作分钟换成固定日历（不读库，省两条查询） */
export function sampleApprovalRegistration(
  kinds: Readonly<Partial<Record<ApprovalKind, ApprovalKindRegistration>>> = SAMPLE_APPROVAL_KINDS,
): ModuleRegistration {
  return defineRegistration("lyxtest_approval", {
    portImplementations: [
      ...Object.entries(kinds).map(([kind, registration]) =>
        implementKeyed(approvalKindPort, kind, registration),
      ),
      implement(workMinutesPort, fixedWorkMinutes),
    ],
  });
}

/** 员工操作的身份上下文（后台请求的样子） */
export const sampleStaffIdentity = (staffId: string): IdentityContext =>
  createIdentityContext({
    actor: { type: "staff", id: staffId, client: "admin" },
    requestId: `req-${staffId.slice(-6)}`,
  });

/** 商家操作的身份上下文（小程序请求的样子） */
export const sampleMerchantIdentity = (
  userId: string,
  entityId: string,
  storeId: string,
): IdentityContext =>
  createIdentityContext({
    actor: { type: "merchant", id: userId, client: "weapp", role: "owner" },
    entityId,
    storeId,
  });

/**
 * 照库里的员工行、角色行、本组成员建员工上下文：与会话校验建出来的同一个办法（authz 的 buildStaffContext）。
 * 会话与登录态由 W1-01a 的后两个 PR 交；在那之前服务层的用例用它。
 */
export async function sampleStaffContext(
  prisma: Pick<PrismaClient, "staff" | "staffRole">,
  staffId: string,
  options: { stepUpAt?: Date | null } = {},
): Promise<StaffContext> {
  const staff = await prisma.staff.findUniqueOrThrow({ where: { id: staffId } });
  const role = await prisma.staffRole.findUniqueOrThrow({ where: { key: staff.staffRoleKey } });
  if (!isStaffRoleKey(staff.staffRoleKey)) throw new Error(`不认识的角色 ${staff.staffRoleKey}`);
  const group =
    staff.staffGroupId === null
      ? []
      : await prisma.staff.findMany({
          where: { staffGroupId: staff.staffGroupId, status: "active" },
          select: { id: true },
        });
  return buildStaffContext({
    staff: {
      id: staff.id,
      roleKey: staff.staffRoleKey,
      isLead: staff.isLead,
      staffGroupId: staff.staffGroupId,
    },
    role: normalizeRoleConfig(staff.staffRoleKey, role),
    groupStaffIds: group.map((member) => member.id),
    stepUpAt: options.stepUpAt ?? null,
  });
}

export interface SampleApprovalOptions {
  /** 替换样例类型的登记；不给即 SAMPLE_APPROVAL_KINDS */
  readonly kinds?: Readonly<Partial<Record<ApprovalKind, ApprovalKindRegistration>>>;
}

/** 样例提交的入参：input 可以不写 */
export type SampleSubmitInput = Omit<SubmitInput<SampleApprovalInput>, "input"> & {
  readonly input?: SampleApprovalInput;
};

/** 一张审批单留下的痕迹：状态、状态历史行数、审计行数、事件名（按发生先后）、探针表上的领域行 */
export interface SampleApprovalTrace {
  status: string | null;
  lockVersion: number | null;
  transitions: number;
  audits: number;
  events: string[];
  domain: SampleDomainRow | null;
}

export interface SampleApproval {
  readonly assembly: Assembly;
  readonly tx: TxRunner;
  readonly clock: AdjustableClock;
  readonly events: Events;
  readonly flow: Flow;
  readonly approval: Approval;
  /** 样例领域用例“提交申请”：开事务 → approval.submit → 插领域行。带幂等上下文时重放不再执行 */
  submit(
    ctx: EmitContext,
    input: SampleSubmitInput,
    options?: { idem?: IdempotencyContext },
  ): Promise<SubmitResult & { domainId: string }>;
  approve(ctx: EmitContext, input: ApproveInput): Promise<DecisionResult>;
  reject(ctx: EmitContext, input: RejectInput): Promise<DecisionResult>;
  withdraw(ctx: EmitContext, input: WithdrawInput): Promise<DecisionResult>;
  /**
   * 样例领域用例“执行”（有执行步的类型）：另一个事务里把领域行推到 done，再调 approval.recordExecuted。
   * fail 为真时在两步之间抛错：事务回滚，审批单不该有任何变化。
   */
  execute(ctx: EmitContext, approvalId: string, options?: { fail?: boolean }): Promise<void>;
  trace(approvalId: string): Promise<SampleApprovalTrace>;
}

/**
 * 测试装配（真实模块的登记加样例审批类型）之上建 events、flow 与 approval：连的是传进来的测试库。
 * 探针表要先建好（SAMPLE_APPROVAL_DDL，属主身份）。
 */
export function createSampleApproval(
  prisma: PrismaClient,
  options: SampleApprovalOptions = {},
): SampleApproval {
  const assembly = assembleForTest({
    entry: "api",
    extra: [sampleApprovalRegistration(options.kinds)],
    withoutRealPorts: [workMinutesPort],
  });
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const clock = createClock();
  const events = createEvents({ assembly, clock, tx });
  const flow = createFlow({ assembly, clock, events });
  const approval = createApproval({
    assembly,
    clock,
    flow,
    events,
    bizNo: createBizNoIssuer({ clock, appEnv: "test" }),
  });

  return {
    assembly,
    tx,
    clock,
    events,
    flow,
    approval,
    submit(ctx, input, { idem } = {}) {
      const domainId = input.input?.domainId ?? uuidv7();
      return tx.run(
        async (handle) => {
          const submitted = await approval.submit(handle, ctx, {
            ...input,
            input: { ...input.input, domainId },
          });
          const hasExecution = approval.kinds.get(input.kind)?.hasExecution === true;
          await handle.$executeRawUnsafe(
            `INSERT INTO ${SAMPLE_APPROVAL_TABLE} (id, approval_request_id, status)
             VALUES ($1::uuid, $2::uuid, $3)`,
            domainId,
            submitted.approvalId,
            hasExecution ? "pending_approval" : "pending",
          );
          return { ...submitted, domainId };
        },
        idem === undefined ? {} : { idem },
      );
    },
    approve: (ctx, input) => tx.run((handle) => approval.approve(handle, ctx, input)),
    reject: (ctx, input) => tx.run((handle) => approval.reject(handle, ctx, input)),
    withdraw: (ctx, input) => tx.run((handle) => approval.withdraw(handle, ctx, input)),
    execute: (ctx, approvalId, { fail = false } = {}) =>
      tx.run(async (handle) => {
        const rows = await handle.$queryRawUnsafe<Array<{ id: string }>>(
          `UPDATE ${SAMPLE_APPROVAL_TABLE} SET executed = executed + 1, status = 'done'
            WHERE approval_request_id = $1::uuid RETURNING id::text AS id`,
          approvalId,
        );
        if (fail) throw new AppError("PROVIDER_UNAVAILABLE", { message: "样例：执行失败" });
        const domainId = rows[0]?.id;
        if (domainId === undefined) throw new AppError("NOT_FOUND");
        await approval.recordExecuted(handle, ctx, {
          approvalId,
          domain: { type: "cancel_request", id: domainId },
        });
      }),
    async trace(approvalId) {
      const row = await prisma.approvalRequest.findUnique({ where: { id: approvalId } });
      const [counts] = await prisma.$queryRawUnsafe<Array<{ transitions: number; audits: number }>>(
        `SELECT (SELECT count(*) FROM status_transition
                  WHERE machine = 'approval_request' AND subject_id = $1::uuid)::int AS transitions,
                (SELECT count(*) FROM audit_log
                  WHERE target_type = 'approval_request' AND target_id = $1::uuid)::int AS audits`,
        approvalId,
      );
      const emitted = await prisma.$queryRawUnsafe<Array<{ type: string }>>(
        `SELECT event_type AS type FROM outbox_event
          WHERE aggregate_type = 'approval_request' AND aggregate_id = $1::uuid ORDER BY id`,
        approvalId,
      );
      const domain = await prisma.$queryRawUnsafe<SampleDomainRow[]>(
        `SELECT id::text AS id, approval_request_id::text AS "approvalRequestId", status,
                close_reason AS "closeReason", revalidated, approved, rejected, withdrawn, executed
           FROM ${SAMPLE_APPROVAL_TABLE} WHERE approval_request_id = $1::uuid`,
        approvalId,
      );
      return {
        status: row?.status ?? null,
        lockVersion: row?.lockVersion ?? null,
        transitions: counts?.transitions ?? 0,
        audits: counts?.audits ?? 0,
        events: emitted.map((item) => item.type),
        domain: domain[0] ?? null,
      };
    },
  };
}

/** 审批读侧的夹具：直接造合法行，只供 GET 接口的测试准备数据，不进生产装配。 */
export function approvalReadFixture(prisma: PrismaClient, clock: { now(): Date }) {
  return async (
    data: Omit<
      Prisma.ApprovalRequestUncheckedCreateInput,
      "id" | "createdAt" | "updatedAt" | "submittedAt"
    > & { submittedAt?: Date },
  ) => {
    const now = clock.now();
    return prisma.approvalRequest.create({
      data: { id: uuidv7(), createdAt: now, updatedAt: now, submittedAt: now, ...data },
    });
  };
}
