import { z, IdSchema, DateSchema } from "@liyoxi/contract";
const text = (min: number, max: number) =>
  z
    .string()
    .refine(
      (value) =>
        [...value].length >= min &&
        [...value].length <= max &&
        (min === 0 || value.trim().length > 0),
    );
const codes = z.array(z.string().min(1)).refine((value) => new Set(value).size === value.length);
const nullableText = (max: number) => text(0, max).nullable();
export const basicInput = z.strictObject({
  lockVersion: z.number().int().nonnegative(),
  title: text(1, 20).optional(),
  posterFileId: IdSchema.nullable().optional(),
  totalEpisodes: z.number().int().min(1).max(999).nullable().optional(),
  episodeDurationSec: z.number().int().positive().nullable().optional(),
  genreCodes: codes.optional(),
  sellingTagCodes: codes.max(3).optional(),
  producerName: nullableText(50).optional(),
  castNames: nullableText(100).optional(),
  synopsis: nullableText(300).optional(),
  dramaClass: z.enum(["class_1", "class_2", "class_3"]).nullable().optional(),
  isAiGenerated: z.boolean().optional(),
});
export const commercialInput = z.strictObject({
  lockVersion: z.number().int().nonnegative(),
  heatTier: z.enum(["S", "A", "B", "C"]).nullable().optional(),
  manualBoost: z.number().int().min(0).max(100).optional(),
  industryCodes: codes.optional(),
  targetAudience: nullableText(100).optional(),
  allowedPlacements: z
    .array(z.enum(["opening", "ending", "corner", "mid_roll"]))
    .refine((value) => new Set(value).size === value.length)
    .optional(),
});
export const copyrightInput = z
  .strictObject({
    lockVersion: z.number().int().nonnegative(),
    source: z.enum(["own", "licensed"]).nullable(),
    platforms: z
      .array(z.enum(["douyin", "wechat_channels"]))
      .refine((value) => new Set(value).size === value.length),
    territory: nullableText(50),
    hasNetworkRight: z.boolean(),
    canSublicense: z.boolean(),
    canEditEmbed: z.boolean(),
    canAdapt: z.boolean(),
    licenseStartDate: DateSchema.nullable(),
    licenseEndDate: DateSchema.nullable(),
    proofFileIds: z
      .array(IdSchema)
      .max(10)
      .refine((value) => new Set(value).size === value.length),
  })
  .refine(
    (value) =>
      !value.licenseStartDate ||
      !value.licenseEndDate ||
      value.licenseStartDate <= value.licenseEndDate,
  );
export const permitInput = z.strictObject({
  platform: z.enum(["all", "douyin", "wechat_channels"]),
  permitKind: z.enum(["license_no", "approval_no", "program_no"]),
  permitNo: text(1, 50),
  scanFileIds: z
    .array(IdSchema)
    .max(10)
    .refine((value) => new Set(value).size === value.length)
    .default([]),
  note: nullableText(200).optional(),
});
export const rolesInput = z.strictObject({
  lockVersion: z.number().int().nonnegative(),
  roles: z
    .array(
      z.strictObject({ name: text(1, 20), actor: nullableText(20).optional(), desc: text(1, 100) }),
    )
    .max(8),
});
export type BasicInput = z.infer<typeof basicInput>;
export type CommercialInput = z.infer<typeof commercialInput>;
export type CopyrightInput = z.infer<typeof copyrightInput>;
export type PermitInput = z.infer<typeof permitInput>;
export type RolesInput = z.infer<typeof rolesInput>;
