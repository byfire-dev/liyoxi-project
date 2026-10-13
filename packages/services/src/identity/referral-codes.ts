import {
  ReferralCodeCreateBodySchema,
  ReferralCodeDisableBodySchema,
  ReferralCodeEnableBodySchema,
} from "@liyoxi/contract";
import type {
  ReferralCodeCreateBody,
  ReferralCodeDisableBody,
  ReferralCodeList,
  ReferralCodeListQuery,
  ReferralCodeRow,
} from "@liyoxi/contract";
import type { AuditRequestMeta } from "../audit/index.js";
import { authorize } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, IdempotencyContext, IdentityContext, Tx, TxRunner } from "../kernel/index.js";
import {
  createReferralCodeIn,
  listReferralCodesIn,
  setReferralCodeStatusIn,
} from "../tenant/index.js";
import { currentIdentityStaff } from "./staff-auth.js";
interface Deps {
  tx: TxRunner;
  clock: Clock;
}
interface Options {
  meta: AuditRequestMeta;
}
interface WriteOptions extends Options {
  idem: IdempotencyContext;
}
export interface ReferralCodes {
  list(
    ctx: IdentityContext,
    staff: StaffContext,
    input: ReferralCodeListQuery,
    options: Options,
  ): Promise<ReferralCodeList>;
  create(
    ctx: IdentityContext,
    staff: StaffContext,
    input: ReferralCodeCreateBody,
    options: WriteOptions,
  ): Promise<ReferralCodeRow>;
  disable(
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    input: ReferralCodeDisableBody,
    options: WriteOptions,
  ): Promise<ReferralCodeRow>;
  enable(
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    input: Record<string, never>,
    options: WriteOptions,
  ): Promise<ReferralCodeRow>;
}
export function createReferralCodes(deps: Deps): ReferralCodes {
  const fresh = async (
    tx: Tx,
    ctx: IdentityContext,
    staff: StaffContext,
    options: Options,
    write: boolean,
  ) => {
    const current = await currentIdentityStaff(tx, deps.clock, ctx, staff, options.meta);
    authorize(
      current,
      {
        module: { module: "merchant", need: "view" },
        permission: write ? "merchant.referral_code.manage" : null,
      },
      deps.clock.now(),
    );
    return current;
  };
  async function write(
    ctx: IdentityContext,
    staff: StaffContext,
    options: WriteOptions,
    locks: readonly string[],
    fn: (tx: Tx, current: StaffContext) => Promise<ReferralCodeRow>,
  ) {
    if (options?.idem?.mode !== "required") throw new AppError("INTERNAL");
    // 缓存命中也重新核当前会话及最新角色权限；global资源不套门店scope。
    await deps.tx.run((tx) => fresh(tx, ctx, staff, options, true));
    return deps.tx.run(
      async (tx) => {
        await lockRows(tx, "staff", [...new Set([staff.staff.id, ...locks])].sort(), "share");
        return fn(tx, await fresh(tx, ctx, staff, options, true));
      },
      { idem: options.idem },
    );
  }
  return {
    list: (ctx, staff, input, options) =>
      deps.tx.run(async (tx) =>
        listReferralCodesIn(
          tx,
          deps.clock,
          ctx,
          await fresh(tx, ctx, staff, options, false),
          input,
        ),
      ),
    create: (ctx, staff, input, options) => {
      const parsed = ReferralCodeCreateBodySchema.safeParse(input);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      return write(
        ctx,
        staff,
        options,
        parsed.data.ownerStaffId ? [parsed.data.ownerStaffId] : [],
        (tx, current) =>
          createReferralCodeIn(tx, deps.clock, ctx, current, parsed.data, options.meta),
      );
    },
    disable: (ctx, staff, id, input, options) => {
      const parsed = ReferralCodeDisableBodySchema.safeParse(input);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      return write(ctx, staff, options, [], (tx, current) =>
        setReferralCodeStatusIn(
          tx,
          deps.clock,
          ctx,
          current,
          id,
          "disable",
          options.meta,
          parsed.data.reasonText,
        ),
      );
    },
    enable: (ctx, staff, id, input, options) => {
      if (!ReferralCodeEnableBodySchema.safeParse(input).success)
        throw new AppError("VALIDATION_FAILED");
      return write(ctx, staff, options, [], (tx, current) =>
        setReferralCodeStatusIn(tx, deps.clock, ctx, current, id, "enable", options.meta),
      );
    },
  };
}
