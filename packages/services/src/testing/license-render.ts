import type { LicenseTemplateCatalog } from "../docs/index.js";

/** TEST ONLY: explicit composition injection; no production legal text. */
export function createTestLicenseTemplateCatalog(): LicenseTemplateCatalog {
  return Object.freeze({
    v1: Object.freeze({
      title: "定制内容授权书",
      notice: "技术联调样张，非法务定稿",
      clauses: Object.freeze([
        Object.freeze({
          key: "v1.rights" as const,
          title: "授权内容（技术样张）",
          paragraphs: Object.freeze([
            "本页仅用于验证授权书渲染与签署技术，不构成真实授权或法务定稿。",
          ]),
        }),
        Object.freeze({
          key: "v1.exclusive" as const,
          title: "使用范围（技术样张）",
          paragraphs: Object.freeze(["测试文字固定于此模板版本，仅用于技术联调。"]),
        }),
        Object.freeze({
          key: "v1.offline" as const,
          title: "测试说明",
          paragraphs: Object.freeze(["真实法务文本、机构证书及受信阅读器验收另行提供。"]),
        }),
      ]),
    }),
  });
}
