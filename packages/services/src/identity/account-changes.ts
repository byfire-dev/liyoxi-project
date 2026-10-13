import {
  AccountChangeApproveBodySchema,
  AccountChangeCreateBodySchema,
  AccountChangeRejectBodySchema,
  AccountChangeWithdrawBodySchema,
} from "@liyoxi/contract";
import type {
  AccountChangeApproveBody,
  AccountChangeCreateBody,
  AccountChangeListQuery,
  AccountChangeRejectBody,
  AccountChangeRequestDetail,
  AccountChangeRequestList,
  AccountChangeWithdrawBody,
} from "@liyoxi/contract";
import type { AuditEntry } from "../audit/index.js";
import { assertConfirm, authorize } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { sealPhone } from "../security/index.js";
import { currentIdentityStaff } from "./staff-auth.js";
import { withAccountChangeCall } from "./account-change-context.js";
import type {
  AccountChangeCall,
  AccountChangeDeps,
  AccountChangeOptions,
  AccountChangeWriteOptions,
} from "./account-change-context.js";
import {
  accountChangeInclude,
  accountChangeScope,
  checkIssue,
  inputFor,
  precheck,
  requestOf,
  targetFacts,
  visibleTarget,
} from "./account-change-facts.js";
import { accountChangeCard, accountChangeDetail } from "./account-change-read.js";
import { pendingAccountChanges } from "./empty-account.js";

export interface AccountChanges {
  list(
    ctx: IdentityContext,
    staff: StaffContext,
    input: AccountChangeListQuery,
    options: AccountChangeOptions,
  ): Promise<AccountChangeRequestList>;
  get(
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    options: AccountChangeOptions,
  ): Promise<AccountChangeRequestDetail>;
  create(
    ctx: IdentityContext,
    staff: StaffContext,
    input: AccountChangeCreateBody,
    options: AccountChangeWriteOptions,
  ): Promise<AccountChangeRequestDetail>;
  approve(
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    input: AccountChangeApproveBody,
    options: AccountChangeWriteOptions,
  ): Promise<AccountChangeRequestDetail>;
  reject(
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    input: AccountChangeRejectBody,
    options: AccountChangeWriteOptions,
  ): Promise<AccountChangeRequestDetail>;
  withdraw(
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    input: AccountChangeWithdrawBody,
    options: AccountChangeWriteOptions,
  ): Promise<AccountChangeRequestDetail>;
}
type Op = "approve" | "reject" | "withdraw";
type DecisionInput = AccountChangeApproveBody | AccountChangeRejectBody | AccountChangeWithdrawBody;
const permissionFor = (op: Op | "create") =>
  op === "create" ? "merchant.account_change.request" : "merchant.account_change.approve";
function allow(staff: StaffContext, deps: AccountChangeDeps, op: Op | "create") {
  authorize(
    staff,
    {
      module: { module: "merchant", need: "view" },
      permission: op === "withdraw" ? null : permissionFor(op),
    },
    deps.clock.now(),
    { skipStepUp: op === "reject" },
  );
}
const audit = (op: "create" | Op, id: string, entityId: string | null): AuditEntry => ({
  stream: "ops",
  category: "account_security",
  action: `identity.account_change.${op}`,
  summary: {
    create: "发起账号变更",
    approve: "通过账号变更",
    reject: "驳回账号变更",
    withdraw: "撤回账号变更",
  }[op],
  ...(entityId ? { entityId } : {}),
  target: { type: op === "create" ? "account_change_request" : "approval_request", id },
});
function writes(options: AccountChangeWriteOptions) {
  if (options?.idem?.mode !== "required") throw new AppError("INTERNAL");
}
async function createLocks(tx: Tx, facts: Awaited<ReturnType<typeof targetFacts>>) {
  if (!facts.user) throw new AppError("NOT_FOUND");
  await lockRows(tx, "merchant_user", [facts.user.id]);
  if (facts.entityId) await lockRows(tx, "entity", [facts.entityId]);
  if (facts.member) await lockRows(tx, "entity_member", [facts.member.id]);
}
async function linkProofs(
  tx: Tx,
  deps: AccountChangeDeps,
  state: AccountChangeCall,
  entityId: string | null,
  fileIds: readonly string[],
) {
  if (!deps.media) throw new AppError("INTERNAL");
  if (new Set(fileIds).size !== fileIds.length) throw new AppError("VALIDATION_FAILED");
  await lockRows(tx, "file_object", [...fileIds].sort());
  for (const fileId of fileIds) {
    const file = await tx.fileObject.findUnique({ where: { id: fileId } });
    if (
      !file ||
      file.uploadActorType !== "staff" ||
      file.uploadActorId !== state.staff.staff.id ||
      file.category !== "account_proof" ||
      file.status !== "stored" ||
      file.moderationState === "block" ||
      (entityId
        ? file.scopeType !== "entity" || file.entityId !== entityId
        : file.scopeType !== "platform" ||
          file.entityId !== null ||
          state.staff.scope.kind !== "all")
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [fileId], reason: "scope_mismatch" },
      });
    await deps.media.link(tx, {
      fileId,
      refType: "account_change_request",
      refId: state.requestId,
      role: "proof",
      entityId,
      storeId: null,
    });
  }
}
async function prepareDecision(tx: Tx, state: AccountChangeCall, op: Op) {
  const { deps } = state;
  let request = await requestOf(tx, state.staff, state.requestId);
  await lockRows(
    tx,
    "staff",
    [...new Set([state.staff.staff.id, request.approvalRequest.requesterStaffId!])].sort(),
    "share",
  );
  const before = op === "approve" ? await precheck(tx, deps, inputFor(request, deps)) : null;
  const occupant =
    request.kind === "phone_rebind" && before?.occupant?.id !== request.merchantUserId
      ? (before?.occupant ?? null)
      : null;
  state.occupantId = occupant?.id ?? null;
  const changes = occupant ? await pendingAccountChanges(tx, occupant.id) : [];
  state.occupantChanges = changes;
  await lockRows(
    tx,
    "approval_request",
    [
      ...new Set([request.approvalRequestId, ...changes.map((change) => change.approvalRequestId)]),
    ].sort(),
  );
  await lockRows(
    tx,
    "account_change_request",
    [...new Set([request.id, ...changes.map((change) => change.id)])].sort(),
  );
  request = await requestOf(tx, state.staff, state.requestId);
  const row = request.approvalRequest;
  if (row.status !== "pending")
    throw new AppError("APPROVAL_NOT_PENDING", {
      details: { status: row.status, decidedAt: row.decidedAt?.toISOString() ?? null },
    });
  if (op !== "withdraw" && row.requesterStaffId === state.staff.staff.id)
    throw new AppError("APPROVAL_SELF_FORBIDDEN");
  if (op !== "approve") return request;
  const input = inputFor(request, deps),
    target = await targetFacts(tx, input);
  let newOwner = before?.occupant ?? null;
  if (request.kind === "owner_transfer" && !newOwner) {
    const sealed = sealPhone(deps.keyring(), "merchant_user.phone_enc", input.newPhone!),
      now = deps.clock.now(),
      id = uuidv7();
    const inserted = await tx.merchantUser.createMany({
      skipDuplicates: true,
      data: [
        {
          id,
          phoneEnc: sealed.enc,
          phoneBidx: sealed.bidx,
          phoneMask: sealed.mask,
          phoneLast4: sealed.last4,
          status: "active",
          sourceType: "organic",
          consentStamp: null,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    state.newOwnerAccountCreated = inserted.count === 1;
    newOwner = await tx.merchantUser.findUniqueOrThrow({ where: { phoneBidx: sealed.bidx } });
  }
  if (request.kind === "owner_transfer") {
    if (!newOwner) throw new AppError("INTERNAL");
    state.newOwnerUserId = newOwner.id;
  }
  const accountIds = [
    ...new Set([
      ...(target.user ? [target.user.id] : []),
      ...(newOwner ? [newOwner.id] : []),
      ...(occupant ? [occupant.id] : []),
    ]),
  ].sort();
  await lockRows(tx, "merchant_user", accountIds);
  const identities = await tx.wechatIdentity.findMany({
    where: { merchantUserId: { in: accountIds } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "wechat_identity",
    identities.map((identity) => identity.id),
  );
  const freshTarget = await targetFacts(tx, input);
  if (freshTarget.user?.id !== target.user?.id || freshTarget.entityId !== target.entityId)
    throw new AppError("BUSY");
  const entityIds = [
    ...new Set([
      ...(request.entityId ? [request.entityId] : []),
      ...(freshTarget.entityId ? [freshTarget.entityId] : []),
    ]),
  ].sort();
  await lockRows(tx, "entity", entityIds);
  const finalTarget = await targetFacts(tx, input);
  if (finalTarget.user?.id !== target.user?.id || finalTarget.entityId !== target.entityId)
    throw new AppError("BUSY");
  const members = await tx.entityMember.findMany({
    where: {
      status: "active",
      OR: [{ merchantUserId: { in: accountIds } }, { entityId: { in: entityIds }, role: "owner" }],
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "entity_member",
    members.map((member) => member.id),
  );
  return request;
}

export function createAccountChanges(deps: AccountChangeDeps): AccountChanges {
  const fresh = (
    tx: Tx,
    ctx: IdentityContext,
    staff: StaffContext,
    options: AccountChangeOptions,
  ) => currentIdentityStaff(tx, deps.clock, ctx, staff, options.meta);
  const get = (
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    options: AccountChangeOptions,
  ) =>
    deps.tx.run(async (tx) => {
      const current = await fresh(tx, ctx, staff, options);
      return accountChangeDetail(tx, deps, current, await requestOf(tx, current, id));
    });
  async function decide(
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    op: Op,
    rawInput: DecisionInput,
    options: AccountChangeWriteOptions,
  ) {
    writes(options);
    const schema =
      op === "approve"
        ? AccountChangeApproveBodySchema
        : op === "reject"
          ? AccountChangeRejectBodySchema
          : AccountChangeWithdrawBodySchema;
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED");
    await deps.tx.run(async (tx) => {
      const current = await fresh(tx, ctx, staff, options);
      allow(current, deps, op);
      await requestOf(tx, current, id);
    });
    let notice: string | undefined;
    const result = await deps.tx.run(
      async (tx) => {
        if (!deps.approval) throw new AppError("INTERNAL");
        const current = await fresh(tx, ctx, staff, options);
        allow(current, deps, op);
        const state: AccountChangeCall = {
          deps,
          ctx,
          staff: current,
          meta: options.meta,
          requestId: id,
          confirm: parsed.data.confirm,
        };
        const request = await prepareDecision(tx, state, op),
          approvalId = request.approvalRequestId;
        state.staff = await fresh(tx, ctx, staff, options);
        allow(state.staff, deps, op);
        await requestOf(tx, state.staff, id);
        if (op === "approve")
          assertConfirm(parsed.data.confirm, {
            requestNo: request.approvalRequest.requestNo,
            newPhoneMask: request.newPhoneMask,
          });
        else assertConfirm(parsed.data.confirm, { requestNo: request.approvalRequest.requestNo });
        await withAccountChangeCall(tx, state, async () => {
          const shared = {
            approvalId,
            staff: state.staff,
            audit: audit(op, approvalId, request.entityId),
            meta: options.meta,
          };
          if (op === "approve") {
            const body = parsed.data as AccountChangeApproveBody;
            await deps.approval!.approve(tx, ctx, {
              ...shared,
              lockVersion: body.lockVersion,
              confirmChecks: body.confirmChecks,
            });
          } else if (op === "reject")
            await deps.approval!.reject(tx, ctx, {
              ...shared,
              note: (parsed.data as AccountChangeRejectBody).note,
            });
          else
            await deps.approval!.withdraw(tx, ctx, {
              ...shared,
              note: (parsed.data as AccountChangeWithdrawBody).note,
            });
        });
        notice = state.oldPhone;
        return accountChangeDetail(tx, deps, state.staff, await requestOf(tx, state.staff, id));
      },
      { idem: options.idem },
    );
    if (notice && deps.notify)
      await deps.notify
        .sendDirect({
          purpose: "account_notice",
          templateKey: "account_notice",
          phone: notice,
          params: {},
          directKey: `account_change:${id}`,
        })
        .catch(() => undefined);
    return result;
  }
  return {
    get,
    list: (ctx, staff, input, options) =>
      deps.tx.run(async (tx) => {
        const current = await fresh(tx, ctx, staff, options),
          where = {
            AND: [
              accountChangeScope(current),
              {
                ...(input.entityId ? { entityId: input.entityId } : {}),
                ...(input.merchantUserId ? { merchantUserId: input.merchantUserId } : {}),
                ...(input.kind ? { kind: { in: input.kind } } : {}),
                ...(input.status ? { approvalRequest: { status: { in: input.status } } } : {}),
              },
            ],
          };
        const total = await tx.accountChangeRequest.count({ where });
        const rows = await tx.accountChangeRequest.findMany({
          where,
          include: accountChangeInclude,
          orderBy: [{ approvalRequest: { submittedAt: "desc" } }, { id: "desc" }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        });
        const items = [];
        for (const row of rows) items.push(await accountChangeCard(tx, deps, current, row));
        return { items, total, page: input.page, pageSize: input.pageSize };
      }),
    create: async (ctx, staff, rawInput, options) => {
      writes(options);
      const parsed = AccountChangeCreateBodySchema.safeParse(rawInput);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const input = parsed.data;
      await deps.tx.run(async (tx) => {
        const current = await fresh(tx, ctx, staff, options);
        allow(current, deps, "create");
        await visibleTarget(tx, current, input);
      });
      return deps.tx.run(
        async (tx) => {
          if (!deps.approval || !deps.media) throw new AppError("INTERNAL");
          await lockRows(tx, "staff", [staff.staff.id], "share");
          let current = await fresh(tx, ctx, staff, options);
          allow(current, deps, "create");
          const target = await visibleTarget(tx, current, input);
          await createLocks(tx, target);
          current = await fresh(tx, ctx, staff, options);
          allow(current, deps, "create");
          const facts = await visibleTarget(tx, current, input);
          if (
            facts.user?.id !== target.user?.id ||
            facts.entityId !== target.entityId ||
            facts.member?.id !== target.member?.id
          )
            throw new AppError("BUSY");
          checkIssue(await precheck(tx, deps, input), false);
          if (
            input.kind === "phone_rebind" &&
            Buffer.from(facts.user!.phoneBidx!).equals(
              sealPhone(deps.keyring(), "merchant_user.phone_enc", input.newPhone).bidx,
            )
          )
            throw new AppError("PHONE_UNCHANGED");
          assertConfirm(input.confirm, { targetPhoneMask: facts.user!.phoneMask });
          const reason = await tx.dictItem.findUnique({
            where: {
              dictTypeKey_code: { dictTypeKey: "account_change_reason", code: input.reasonCode },
            },
          });
          if (!reason?.isEnabled) throw new AppError("VALIDATION_FAILED");
          const id = uuidv7(),
            state: AccountChangeCall = {
              deps,
              ctx,
              staff: current,
              meta: options.meta,
              requestId: id,
              input,
            };
          const submitted = await withAccountChangeCall(tx, state, () =>
            deps.approval!.submit(tx, ctx, {
              kind: "account_change",
              subjectType: input.kind === "owner_transfer" ? "entity" : "merchant_user",
              subjectId: input.kind === "owner_transfer" ? input.entityId : input.merchantUserId,
              entityId: facts.entityId,
              input,
              idempotencyKey: options.idem.key!,
              audit: audit("create", id, facts.entityId),
              meta: options.meta,
            }),
          );
          const now = deps.clock.now(),
            sealed =
              input.kind === "owner_reverify"
                ? null
                : sealPhone(deps.keyring(), "account_change_request.new_phone_enc", input.newPhone);
          await tx.accountChangeRequest.create({
            data: {
              id,
              approvalRequestId: submitted.approvalId,
              kind: input.kind,
              merchantUserId: input.kind === "owner_transfer" ? null : input.merchantUserId,
              entityId: facts.entityId,
              newPhoneEnc: sealed?.enc ?? null,
              newPhoneMask: sealed?.mask ?? null,
              proofFileIds: input.proofFileIds,
              verifyMethod: input.kind === "owner_reverify" ? input.verifyMethod : null,
              verifyRecord: input.kind === "owner_reverify" ? input.verifyRecord : null,
              reasonCode: input.reasonCode,
              reasonText: input.reasonText,
              createdAt: now,
              updatedAt: now,
            },
          });
          await linkProofs(tx, deps, state, facts.entityId, input.proofFileIds);
          return accountChangeDetail(tx, deps, current, await requestOf(tx, current, id));
        },
        { idem: options.idem },
      );
    },
    approve: (ctx, staff, id, input, options) => decide(ctx, staff, id, "approve", input, options),
    reject: (ctx, staff, id, input, options) => decide(ctx, staff, id, "reject", input, options),
    withdraw: (ctx, staff, id, input, options) =>
      decide(ctx, staff, id, "withdraw", input, options),
  };
}
