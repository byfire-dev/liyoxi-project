// 协议：agreement_version、agreement_consent（13 分组）。协议清单（agreement）是种子，要配带种子的库用。
import { defined, fakeBizNo, fakePhone, seedMissing, sha256Hex } from "./context.js";
import type { FactoryContext } from "./context.js";
import { resolveScope } from "./lookups.js";
import type { Factories, TableFactories } from "./types.js";

/** 同意场景缺省对应哪份协议 */
const KEY_BY_SCENE: Record<string, string> = {
  login: "user",
  reconsent: "user",
  member_join: "user",
  plan_purchase: "member",
  topup: "points",
  order_submit: "custom_license",
  ad_request: "ad_service",
};

/** 带业务单据的场景：单据类型与单号前缀 */
const BIZ_BY_SCENE: Record<string, readonly [type: string, prefix: string]> = {
  plan_purchase: ["billing_order", "FK"],
  topup: ["billing_order", "FK"],
  order_submit: ["drama_order", "LYX"],
  ad_request: ["ad", "GG"],
};

export function docsFactories(
  ctx: FactoryContext,
  make: Factories,
): Pick<TableFactories, "agreementVersion" | "agreementConsent"> {
  return {
    /**
     * 缺省：《定制内容授权使用协议》（custom_license）的一个生效版本，带一份登记了的 PDF 与正文指纹，法务已确认。
     * 主版本号取“这份协议已有的版本数 + 1”。一份协议同时只能有一个生效版本：要第二个就给别的状态。
     * 会员协议、积分规则（member、points）的非草稿版本库里要求挂公告：自己给 siteNoticeId，或写 status: "draft"。
     */
    async agreementVersion(input = {}) {
      const id = input.id ?? ctx.id();
      const now = ctx.now();
      const agreementKey = input.agreementKey ?? "custom_license";
      const status = input.status ?? "active";
      const staffId =
        input.createdByStaffId ?? (await make.staff({ staffRoleKey: "super_admin" })).id;
      const published =
        status === "draft"
          ? {}
          : {
              effectiveAt: now,
              summary: "测试用的协议版本",
              pdfFileId:
                input.pdfFileId ??
                (
                  await make.fileObject({
                    bucket: "secure",
                    category: "legal_doc",
                    ext: "pdf",
                    declaredMime: "application/pdf",
                    mime: "application/pdf",
                  })
                ).id,
              contentSha256: sha256Hex(`agreement:${id}`),
              isLegalApproved: true,
              publishedByStaffId: staffId,
            };
      return ctx.db.agreementVersion.create({
        data: {
          major: (await ctx.db.agreementVersion.count({ where: { agreementKey } })) + 1,
          minor: 0,
          ...published,
          ...(status === "active" || status === "superseded" ? { activatedAt: now } : {}),
          createdByStaffId: staffId,
          createdAt: now,
          updatedAt: now,
          ...defined(input),
          id,
          agreementKey,
          status,
        },
      });
    },

    /**
     * 缺省：提交订购时勾选同意《定制内容授权使用协议》的一条记录（场景 order_submit），老板本人，带主体与门店。
     * 协议版本没给时取这份协议生效中的版本，没有才造；正文指纹抄自版本（库里的触发器要它一致）。
     * 换场景（scene）时，协议、同意方式、业务单据类型与单号前缀跟着场景走。只增表：插了删不掉。
     */
    async agreementConsent({ phone, ...input } = {}) {
      const n = ctx.seq();
      const now = ctx.now();
      const scene = input.scene ?? "order_submit";
      const agreementKey = input.agreementKey ?? KEY_BY_SCENE[scene];
      if (agreementKey === undefined) throw new Error(`不认识的同意场景：${scene}`);
      const version =
        input.agreementVersionId === undefined
          ? ((await ctx.db.agreementVersion.findFirst({
              where: { agreementKey, status: "active" },
            })) ?? (await make.agreementVersion({ agreementKey })))
          : await ctx.db.agreementVersion.findUniqueOrThrow({
              where: { id: input.agreementVersionId },
            });
      if (version.contentSha256 === null) throw seedMissing("带正文指纹的协议版本");

      const biz = BIZ_BY_SCENE[scene];
      const needsStore = scene === "order_submit" || scene === "ad_request";
      let entityId = input.entityId ?? undefined;
      let storeId = input.storeId ?? undefined;
      if (needsStore) ({ entityId, storeId } = await resolveScope(ctx, make, input));
      else if (biz !== undefined) entityId ??= (await make.entity()).id;
      const merchantUserId =
        input.merchantUserId ??
        (entityId === undefined
          ? (await make.merchantUser()).id
          : (await ctx.db.entity.findUniqueOrThrow({ where: { id: entityId } })).createdByUserId);
      const sealed = ctx.seal.phone("agreement_consent.phone_enc", phone ?? fakePhone(n));
      return ctx.db.agreementConsent.create({
        data: {
          id: ctx.id(),
          phoneEnc: sealed.enc,
          phoneMask: sealed.mask,
          role: "owner",
          method: scene === "plan_purchase" || scene === "topup" ? "by_action" : "checkbox",
          ...(biz === undefined
            ? {}
            : {
                bizType: biz[0],
                bizId: ctx.id(),
                bizNo: fakeBizNo(biz[1], ctx.today(), n),
              }),
          consentedAt: now,
          ip: "127.0.0.1",
          deviceSnapshot: {},
          requestId: `req_test_${n}`,
          createdAt: now,
          ...defined(input),
          agreementKey,
          agreementVersionId: version.id,
          contentSha256: input.contentSha256 ?? version.contentSha256,
          merchantUserId,
          entityId,
          storeId,
          scene,
        },
      });
    },
  };
}
