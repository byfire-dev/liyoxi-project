// 员工：staff（03 分组）。角色是种子里的 8 个之一，所以要配带种子的库用。
import { defined, fakePhone } from "./context.js";
import type { FactoryContext } from "./context.js";
import type { TableFactories } from "./types.js";

export function staffFactories(ctx: FactoryContext): Pick<TableFactories, "staff"> {
  return {
    /** 缺省：在职的交付经理，没设密码、没绑动态口令。工号由库里的序列给 */
    async staff({ phone, ...input } = {}) {
      const n = ctx.seq();
      const now = ctx.now();
      const sealed = ctx.seal.phone("staff.phone_enc", phone ?? fakePhone(n));
      return ctx.db.staff.create({
        data: {
          id: ctx.id(),
          name: `测试员工${n}`,
          phoneEnc: sealed.enc,
          phoneBidx: sealed.bidx,
          phoneMask: sealed.mask,
          phoneLast4: sealed.last4,
          staffRoleKey: "delivery_manager",
          status: "active",
          createdAt: now,
          updatedAt: now,
          ...defined(input),
        },
      });
    },
  };
}
