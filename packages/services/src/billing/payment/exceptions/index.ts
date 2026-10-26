import type { PaymentExceptionCreateBody, PaymentExceptionListQuery } from "@liyoxi/contract";
import type { StaffContext } from "../../../authz/index.js";
import type { IdentityContext } from "../../../kernel/index.js";
import type { PaymentExceptionDeps } from "./context.js";
import { detail, list } from "./read.js";
import { create } from "./create.js";
import { createResolver, required } from "./resolve.js";
import type { WriteOptions } from "./resolve.js";
/** 同一差异资源的用例边界，只有需要渠道事实的分支走C51。 */
export function createPaymentExceptions(deps: PaymentExceptionDeps) {
  return {
    list: (staff: StaffContext, query: PaymentExceptionListQuery) =>
      deps.tx.run((tx) => list(tx, deps, staff, query)),
    get: (staff: StaffContext, id: string) => deps.tx.run((tx) => detail(tx, deps, staff, id)),
    create: (
      ctx: IdentityContext,
      staff: StaffContext,
      input: PaymentExceptionCreateBody,
      options: WriteOptions,
    ) => {
      required(options);
      return deps.tx.run(
        async (tx) => detail(tx, deps, staff, await create(tx, deps, ctx, staff, input)),
        options,
      );
    },
    resolve: createResolver(deps),
  };
}
export type { PaymentExceptionDeps } from "./context.js";
