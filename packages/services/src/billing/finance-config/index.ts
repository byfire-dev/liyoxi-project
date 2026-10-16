import { z } from "zod";
import { defineApprovalKind } from "../../approval/index.js";
import type { Approval } from "../../approval/index.js";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../../kernel/index.js";
import { assertPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { sealBankAccount } from "../../security/index.js";
import type { Keyring } from "../../security/index.js";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import type { Controls, PurchaseRule } from "@liyoxi/shared/purchase-policy";

export const FINANCE_CONFIG_KEYS = ["bank_account", "purchase_policy", "controls"] as const;
export type FinanceConfigKey = (typeof FINANCE_CONFIG_KEYS)[number];
const amount = z.int().nonnegative();
const copy = z.strictObject({
  planNounKey: z.string().min(1),
  pointsNounKey: z.string().min(1),
  payButtonKey: z.string().min(1),
});
const when = z.strictObject({
  platforms: z
    .array(z.enum(["ios", "android", "harmony", "windows", "mac", "devtools", "unknown"]))
    .optional(),
  versionRange: z
    .string()
    .min(1)
    .regex(
      /^(?:>=|<=|>|<|=)\d{1,5}\.\d{1,5}\.\d{1,5}(?: (?:>=|<=|>|<|=)\d{1,5}\.\d{1,5}\.\d{1,5})*$/,
    )
    .optional(),
  entityIds: z.array(z.uuid()).optional(),
  types: z.array(z.enum(["plan_new", "plan_renew", "plan_upgrade", "topup"])).optional(),
  amountGteFen: amount.optional(),
  amountLtFen: amount.optional(),
});
const schemas = {
  bank_account: z.strictObject({
    accountName: z.string().min(1).max(200),
    bankName: z.string().min(1).max(200),
    accountNo: z.string().regex(/^[0-9\s]{8,64}$/),
  }),
  purchase_policy: z.strictObject({
    rules: z
      .array(
        z.strictObject({
          when,
          then: z.strictObject({
            mode: z.enum(["in_app", "offline_contract", "hidden"]).optional(),
            channels: z
              .strictObject({
                wechat_jsapi: z.enum(["on", "off"]).optional(),
                bank_transfer: z.enum(["on", "off"]).optional(),
              })
              .optional(),
            copySet: copy.optional(),
          }),
        }),
      )
      .max(100),
  }),
  controls: z.strictObject({
    adminCreateOrder: z.boolean(),
    wechatSingleLimitFen: amount,
    wechatDailyLimitFen: amount,
    receiptSecondReviewFen: z.int().positive().nullable(),
    shippingReport: z.boolean(),
  }),
};
export interface FinanceProposal {
  configKey: FinanceConfigKey;
  payload: unknown;
  changeNote: string;
}
function validate(input: FinanceProposal) {
  if (
    !FINANCE_CONFIG_KEYS.includes(input.configKey) ||
    !schemas[input.configKey].safeParse(input.payload).success ||
    !input.changeNote.trim() ||
    input.changeNote.length > 500
  )
    throw new AppError("VALIDATION_FAILED");
}
export const financeConfigApproval = defineApprovalKind<FinanceProposal>({
  category: "approval",
  domain: { table: "finance_config_revision", column: "approval_request_id" },
  viewModules: ["finance"],
  decidePermission: "finance.config.approve",
  groupBound: false,
  hasExecution: false,
  numberPrefix: null,
  dedupeKey: (s) => `finance_config_change:${s.input.configKey}`,
  operations: {
    get: "admin.financeConfigRevision.list",
    approve: "admin.financeConfigRevision.approve",
    reject: "admin.financeConfigRevision.reject",
    withdraw: "admin.financeConfigRevision.withdraw",
  },
  validate: async (_tx, s) => validate(s.input),
  summarize: async (_tx, s) => ({
    title: "受控财务配置变更",
    lines: [
      { label: "配置键", value: s.input.configKey },
      { label: "说明", value: s.input.changeNote.slice(0, 200) },
    ],
    domain: { type: "finance_config_revision", id: s.subjectId },
  }),
  revalidate: async (tx, row) => {
    const r = await tx.financeConfigRevision.findUnique({ where: { id: row.subjectId } });
    if (!r || r.effectiveAt !== null) throw new AppError("PRECONDITION_CHANGED");
  },
  onApproved: async (tx, row, decision) => {
    const r = await tx.financeConfigRevision.findUniqueOrThrow({ where: { id: row.subjectId } });
    if (decision.decidedByStaffId === null || decision.decidedByStaffId === row.requesterStaffId)
      throw new AppError("APPROVAL_SELF_FORBIDDEN");
    await tx.financeConfigRevision.update({
      where: { id: r.id },
      data: {
        effectiveAt: new Date(
          decision.decidedAt.getTime() + (r.configKey === "bank_account" ? 86_400_000 : 0),
        ),
      },
    });
  },
  onRejected: async () => {},
  onWithdrawn: async () => {},
});
export async function proposeFinanceConfig(
  tx: Tx,
  deps: { approval: Approval; clock: Clock; keyring: Keyring },
  ctx: IdentityContext,
  input: FinanceProposal,
  staff: StaffContext,
  options: { idempotencyKey?: string | null } = {},
) {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertPermission(staff, "finance.config.propose", deps.clock.now());
  validate(input);
  const id = uuidv7();
  const request = await deps.approval.submit(tx, ctx, {
    kind: "finance_config_change",
    subjectType: "finance_config_revision",
    subjectId: id,
    idempotencyKey: options.idempotencyKey ?? null,
    input,
    ...(ctx.actor.client === "cli"
      ? {
          meta: {
            requestId: ctx.requestId,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            authMethod: null,
            sessionId: null,
            jobName: "cli.db.seed.demo.billing",
          },
        }
      : {}),
  });
  const parsed = schemas[input.configKey].parse(input.payload);
  let payload: object = parsed,
    accountNoEnc: string | null = null,
    accountNoMask: string | null = null;
  if (input.configKey === "bank_account") {
    const bank = schemas.bank_account.parse(parsed),
      sealed = sealBankAccount(
        deps.keyring,
        "finance_config_revision.account_no_enc",
        bank.accountNo,
      );
    accountNoEnc = sealed.enc;
    accountNoMask = sealed.mask;
    payload = { accountName: bank.accountName, bankName: bank.bankName, accountNoMask };
  }
  await tx.financeConfigRevision.create({
    data: {
      id,
      configKey: input.configKey,
      payload,
      accountNoEnc,
      accountNoMask,
      changeNote: input.changeNote,
      approvalRequestId: request.approvalId,
      createdAt: deps.clock.now(),
    },
  });
  return { financeConfigRevisionId: id, ...request };
}
export async function financeConfigAt(tx: Tx, at: Date) {
  const rows = await tx.financeConfigRevision.findMany({
    where: { effectiveAt: { lte: at }, approvalRequest: { status: "approved" } },
    orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
  });
  const bank = rows.find((r) => r.configKey === "bank_account") ?? null,
    policy = rows.find((r) => r.configKey === "purchase_policy"),
    control = rows.find((r) => r.configKey === "controls");
  return {
    bank,
    rules: policy ? (policy.payload as unknown as { rules: PurchaseRule[] }).rules : [],
    controls: control ? (control.payload as unknown as Controls) : DEFAULT_CONTROLS,
  };
}
