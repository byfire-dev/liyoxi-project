import { z } from "../../zod.js";
import { IdSchema, InstantSchema, PageQuerySchema, orNull } from "../../common/index.js";
import { FOLLOW_UP_CHANNEL, FOLLOW_UP_SUBJECT_TYPE } from "../../enums/index.js";
import { StaffBriefSchema, adminPage } from "../a01-system/structures.js";

export const FollowUpSubjectSchema = z.enum(FOLLOW_UP_SUBJECT_TYPE.values);
const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && [...value].length <= 200);
const inputTime = z.iso.datetime({ offset: true });
const intent = z.enum(["confirmed", "considering", "declined"]);
const queryBool = z.stringbool({ truthy: ["true"], falsy: ["false"] }).openapi({ type: "boolean" });
export const FollowUpParamsSchema = z.strictObject({ followUpId: IdSchema });
export const FollowUpListQuerySchema = PageQuerySchema.extend({
  subjectType: FollowUpSubjectSchema.optional(),
  subjectId: IdSchema.optional(),
  entityId: IdSchema.optional(),
  storeId: IdSchema.optional(),
  mine: queryBool.optional(),
  isOpen: queryBool.optional(),
})
  .strict()
  .refine((q) => (q.subjectType === undefined) === (q.subjectId === undefined), {
    message: "subjectType与subjectId须成对提供",
  })
  .refine(
    (q) =>
      q.subjectId !== undefined ||
      q.entityId !== undefined ||
      q.storeId !== undefined ||
      q.mine === true,
    {
      message: "须按对象、主体、门店或本人查询",
    },
  );
export const FollowUpCreateBodySchema = z
  .strictObject({
    subjectType: FollowUpSubjectSchema.exclude(["store"]),
    subjectId: IdSchema,
    channel: z.enum(FOLLOW_UP_CHANNEL.values).exclude(["system"]).optional(),
    content: text,
    intent: intent.optional(),
    nextFollowAt: inputTime.optional(),
  })
  .refine((q) => q.intent === undefined || q.subjectType === "subscription_term", {
    message: "只有续费跟进可填写意向",
  });
export const FollowUpUpdateBodySchema = z.strictObject({
  lockVersion: z.int().min(0),
  nextFollowAt: orNull(inputTime),
});
export const FollowUpCompleteBodySchema = z.strictObject({
  lockVersion: z.int().min(0),
  doneNote: z
    .string()
    .refine((value) => [...value].length <= 200)
    .optional(),
});
export const FollowUpItemSchema = z
  .strictObject({
    followUpId: IdSchema,
    subjectType: FollowUpSubjectSchema,
    subjectId: IdSchema,
    entityId: IdSchema,
    storeId: orNull(IdSchema),
    channel: orNull(z.enum(FOLLOW_UP_CHANNEL.values)),
    content: z.string(),
    intent: orNull(intent),
    nextFollowAt: orNull(InstantSchema),
    isOpen: z.boolean(),
    owner: orNull(StaffBriefSchema),
    doneAt: orNull(InstantSchema),
    doneNote: orNull(z.string()),
    recorder: z.strictObject({
      actorType: z.enum(["staff", "system"]),
      staff: orNull(StaffBriefSchema),
    }),
    createdAt: InstantSchema,
    lockVersion: z.int().min(0),
    actions: z.array(z.enum(["update", "complete"])),
  })
  .openapi("FollowUpItem");
export const FollowUpPageSchema = adminPage(FollowUpItemSchema).openapi("FollowUpPage");
export type FollowUpItem = z.infer<typeof FollowUpItemSchema>;
export type FollowUpListQuery = z.infer<typeof FollowUpListQuerySchema>;
