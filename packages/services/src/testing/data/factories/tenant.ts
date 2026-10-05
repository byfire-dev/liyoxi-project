// 商家一侧的五张表：merchant_user、entity、store、entity_member、store_member（02 分组）。
import { maskName } from "@liyoxi/shared/mask";

import { defined, fakePhone, fakeUscc } from "./context.js";
import type { FactoryContext } from "./context.js";
import type { Factories, TableFactories } from "./types.js";

type TenantFactories = Pick<
  TableFactories,
  "merchantUser" | "entity" | "store" | "entityMember" | "storeMember"
>;

export function tenantFactories(ctx: FactoryContext, make: Factories): TenantFactories {
  return {
    /** 缺省：正常状态、自然来源。注销等状态要把手机号几列与 deletedAt 一起给 */
    async merchantUser({ phone, ...input } = {}) {
      const n = ctx.seq();
      const now = ctx.now();
      const sealed = ctx.seal.phone("merchant_user.phone_enc", phone ?? fakePhone(n));
      return ctx.db.merchantUser.create({
        data: {
          id: ctx.id(),
          phoneEnc: sealed.enc,
          phoneBidx: sealed.bidx,
          phoneMask: sealed.mask,
          phoneLast4: sealed.last4,
          displayName: `测试用户${n}`,
          status: "active",
          sourceType: "organic",
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
          ...defined(input),
        },
      });
    },

    /** 缺省：未提交认证。verificationStatus 写 verified 时，名称、类型、信用代码、认证时间跟着补上 */
    async entity({ uscc, legalRepName, ...input } = {}) {
      const n = ctx.seq();
      const now = ctx.now();
      const verified = input.verificationStatus === "verified";
      const sealedUscc =
        uscc !== undefined || verified
          ? ctx.seal.uscc("entity.uscc_enc", uscc ?? fakeUscc(n))
          : undefined;
      return ctx.db.entity.create({
        data: {
          id: ctx.id(),
          lifecycle: "active",
          verificationStatus: "unsubmitted",
          sourceType: "organic",
          createdByUserId: input.createdByUserId ?? (await make.merchantUser()).id,
          ...(verified ? { name: `测试主体${n}`, entityType: "enterprise", verifiedAt: now } : {}),
          ...(sealedUscc
            ? { usccEnc: sealedUscc.enc, usccBidx: sealedUscc.bidx, usccMask: sealedUscc.mask }
            : {}),
          ...(legalRepName === undefined
            ? {}
            : {
                legalRepNameEnc: ctx.seal.text("entity.legal_rep_name_enc", legalRepName),
                legalRepNameMask: maskName(legalRepName),
              }),
          createdAt: now,
          updatedAt: now,
          ...defined(input),
        },
      });
    },

    /** 缺省：营业中、资质未提交、不是首家门店（首家门店一个主体只能有一个，要的话写 isPrimary: true） */
    async store(input = {}) {
      const n = ctx.seq();
      const now = ctx.now();
      return ctx.db.store.create({
        data: {
          id: ctx.id(),
          entityId: input.entityId ?? (await make.entity()).id,
          name: `测试门店${n}`,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
          ...defined(input),
        },
      });
    },

    /**
     * 没给主体：造一个主体，成员是它的创建人，角色老板。
     * 给了主体：角色缺省是店员（一个主体只能有一位老板）；没给人就另造一个用户。
     */
    async entityMember(input = {}) {
      const n = ctx.seq();
      const now = ctx.now();
      let { entityId, merchantUserId } = input;
      const role = input.role ?? (entityId === undefined ? "owner" : "clerk");
      if (entityId === undefined) {
        const entity = await make.entity(
          merchantUserId === undefined ? {} : { createdByUserId: merchantUserId },
        );
        entityId = entity.id;
        merchantUserId = entity.createdByUserId;
      }
      merchantUserId ??= (await make.merchantUser()).id;
      return ctx.db.entityMember.create({
        data: {
          id: ctx.id(),
          displayName: `测试成员${n}`,
          status: "active",
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          entityId,
          merchantUserId,
          role,
        },
      });
    },

    /**
     * 店员与门店的关系。四个外键要同属一个主体：给了其中哪个，主体就跟着它；
     * 没给的店员、门店现造，“谁加的”取这个主体现任的老板（没有就造一位）。
     */
    async storeMember(input = {}) {
      let entityId = input.entityId;
      if (entityId === undefined && input.entityMemberId !== undefined) {
        entityId = (
          await ctx.db.entityMember.findUniqueOrThrow({ where: { id: input.entityMemberId } })
        ).entityId;
      }
      if (entityId === undefined && input.storeId !== undefined) {
        entityId = (await ctx.db.store.findUniqueOrThrow({ where: { id: input.storeId } }))
          .entityId;
      }
      let addedByMemberId = input.addedByMemberId;
      if (entityId === undefined) {
        const owner =
          addedByMemberId === undefined
            ? await make.entityMember()
            : await ctx.db.entityMember.findUniqueOrThrow({ where: { id: addedByMemberId } });
        entityId = owner.entityId;
        addedByMemberId = owner.id;
      }
      addedByMemberId ??= (
        (await ctx.db.entityMember.findFirst({
          where: { entityId, role: "owner", status: "active" },
        })) ?? (await make.entityMember({ entityId, role: "owner" }))
      ).id;
      return ctx.db.storeMember.create({
        data: {
          createdAt: ctx.now(),
          ...defined(input),
          entityId,
          addedByMemberId,
          entityMemberId: input.entityMemberId ?? (await make.entityMember({ entityId })).id,
          storeId: input.storeId ?? (await make.store({ entityId })).id,
        },
      });
    },
  };
}
