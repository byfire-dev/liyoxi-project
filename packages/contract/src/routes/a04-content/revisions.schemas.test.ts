import { expect, it } from "vitest";
import { DramaPriceCreateBodySchema } from "./drama-pricing.schemas.js";
import { CopyrightRevisionCreateBodySchema } from "./drama-copyright.schemas.js";

it("a04.3.33 customPoints仅custom必填，template可省略或null且不接受非空价", () => {
  const input = {
    mode: "template",
    effectiveDate: null,
    reasonCode: "restore_template",
    confirm: { currentPoints: 2000 },
  };
  expect(DramaPriceCreateBodySchema.safeParse(input).success).toBe(true);
  expect(DramaPriceCreateBodySchema.safeParse({ ...input, customPoints: null }).success).toBe(true);
  expect(DramaPriceCreateBodySchema.safeParse({ ...input, customPoints: 1800 }).success).toBe(
    false,
  );
  const custom = { ...input, mode: "custom", reasonCode: "quality" };
  expect(DramaPriceCreateBodySchema.safeParse(custom).success).toBe(false);
  expect(DramaPriceCreateBodySchema.safeParse({ ...custom, customPoints: null }).success).toBe(
    false,
  );
  expect(DramaPriceCreateBodySchema.safeParse({ ...custom, customPoints: 99 }).success).toBe(false);
  expect(DramaPriceCreateBodySchema.safeParse({ ...custom, customPoints: 1800 }).success).toBe(
    true,
  );
  expect(
    DramaPriceCreateBodySchema.safeParse({ ...custom, customPoints: 1800, secret: "extra" })
      .success,
  ).toBe(false);
});

it("版权修订只收完整快照/真实日期/1–10不重复依据，initial不能来自客户端", () => {
  const proof = "019ba146-0000-7000-8000-000000000001";
  const input = {
    lockVersion: 0,
    changeKind: "extend",
    reason: "合法续期依据",
    revisionProofFileIds: [proof],
    confirm: { prevEndDate: "2027-12-31" },
    copyright: {
      source: "licensed",
      platforms: ["douyin"],
      territory: "中国大陆",
      hasNetworkRight: true,
      canSublicense: true,
      canEditEmbed: true,
      canAdapt: true,
      licenseStartDate: "2026-01-01",
      licenseEndDate: "2028-12-31",
      proofFileIds: [proof],
    },
  };
  expect(CopyrightRevisionCreateBodySchema.safeParse(input).success).toBe(true);
  for (const patch of [
    { changeKind: "initial" },
    { revisionProofFileIds: [] },
    { revisionProofFileIds: [proof, proof] },
    { confirm: { prevEndDate: null } },
    { reason: "" },
    { rawProof: "extra" },
    { copyright: { ...input.copyright, licenseEndDate: null } },
    { copyright: { ...input.copyright, licenseEndDate: "2026-02-30" } },
  ])
    expect(CopyrightRevisionCreateBodySchema.safeParse({ ...input, ...patch }).success).toBe(false);
});
