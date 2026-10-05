// docs 的种子（W0-21）：6 份点击同意类协议的清单（13 分组 第 2.10 节；两栏说明文案取后台原型 OpsAgreements）。
// 只是清单行，协议正文与版本不在这里（占位版本随 W1-03）。《服务商合作协议》留到 V1.1。没有才插。
import type {
  AGREEMENT_CONSENT_MODE,
  AGREEMENT_CONSENT_SCENE,
  AGREEMENT_SUBJECT_KIND,
  EnumValue,
} from "@liyoxi/contract";

import { defineSeed, insertMissing } from "../kernel/index.js";

export interface AgreementSeed {
  readonly key: string;
  readonly name: string;
  readonly subjectKind: EnumValue<typeof AGREEMENT_SUBJECT_KIND>;
  readonly consentMode: EnumValue<typeof AGREEMENT_CONSENT_MODE>;
  readonly scenes: readonly EnumValue<typeof AGREEMENT_CONSENT_SCENE>[];
  /** 后台“签署场景”一栏 */
  readonly signSceneLabel: string;
  /** 后台“适用对象”一栏 */
  readonly audienceLabel: string;
}

/** 顺序即 sort_no */
export const AGREEMENT_SEEDS: readonly AgreementSeed[] = [
  {
    key: "user",
    name: "《用户服务协议》",
    subjectKind: "user",
    consentMode: "checkbox",
    scenes: ["login", "reconsent", "member_join"],
    signSceneLabel: "首次登录时勾选同意",
    audienceLabel: "全部用户",
  },
  {
    key: "privacy",
    name: "《隐私政策》",
    subjectKind: "user",
    consentMode: "checkbox",
    scenes: ["login", "reconsent", "member_join"],
    signSceneLabel: "首次登录时勾选同意",
    audienceLabel: "全部用户",
  },
  {
    key: "member",
    name: "《会员服务协议》",
    subjectKind: "entity",
    consentMode: "by_action",
    scenes: ["plan_purchase"],
    signSceneLabel: "开通、续费、升级套餐时付款即同意",
    audienceLabel: "开通套餐的商家",
  },
  {
    key: "points",
    name: "《积分规则》",
    subjectKind: "entity",
    consentMode: "by_action",
    scenes: ["plan_purchase", "topup"],
    signSceneLabel: "开通套餐、加购积分时付款即同意",
    audienceLabel: "付费商家",
  },
  {
    key: "custom_license",
    name: "《定制内容授权使用协议》",
    subjectKind: "entity",
    consentMode: "checkbox",
    scenes: ["order_submit"],
    signSceneLabel: "提交订购时勾选同意",
    audienceLabel: "订购短剧的商家",
  },
  {
    key: "ad_service",
    name: "《广告制作与交付服务协议》",
    subjectKind: "entity",
    consentMode: "checkbox",
    scenes: ["ad_request"],
    signSceneLabel: "首次提交广告需求时勾选同意",
    audienceLabel: "提交广告需求的商家",
  },
];

export const seed = defineSeed("docs", async (tx, { now }) => [
  await insertMissing({
    table: "agreement",
    rows: AGREEMENT_SEEDS,
    keyOf: (row) => row.key,
    existingKeys: async () =>
      (await tx.agreement.findMany({ select: { key: true } })).map((row) => row.key),
    insert: (missing) =>
      tx.agreement.createMany({
        data: missing.map((row) => ({
          key: row.key,
          name: row.name,
          subjectKind: row.subjectKind,
          consentMode: row.consentMode,
          scenes: [...row.scenes],
          signSceneLabel: row.signSceneLabel,
          audienceLabel: row.audienceLabel,
          sinceVersion: "V1.0",
          sortNo: AGREEMENT_SEEDS.indexOf(row) + 1,
          createdAt: now,
          updatedAt: now,
        })),
      }),
  }),
]);
