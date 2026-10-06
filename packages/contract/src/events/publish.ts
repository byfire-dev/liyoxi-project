import { z } from "../zod.js";
import { IdSchema } from "../common/index.js";
import { CHANNEL_PLATFORM } from "../enums/index.js";
const transition = {
  fromState: z.union([z.string(), z.null()]),
  toState: z.string(),
  transition: z.string(),
};
const account = {
  v: z.literal(1),
  channelAccountId: IdSchema,
  entityId: IdSchema,
  storeId: IdSchema,
  ...transition,
};
const launch = { v: z.literal(1), launchTaskId: IdSchema, orderItemId: IdSchema, ...transition };
export const payloads = {
  "account.submitted": z.strictObject({
    ...account,
    platform: z.enum(CHANNEL_PLATFORM.values),
    approvalRequestId: IdSchema,
  }),
  "account.verified": z.strictObject(account),
  "account.abnormal": z.strictObject({
    ...account,
    abnormalSource: z.enum(["verify", "manual"]),
    reasonCode: z.string(),
  }),
  "launch.created": z.strictObject({ ...launch, channelAccountId: IdSchema }),
  "launch.submitted": z.strictObject({
    ...launch,
    deliveryTicketId: IdSchema,
    roundNo: z.int().positive(),
    approvalRequestId: IdSchema,
  }),
  "launch.verified": z.strictObject({
    ...launch,
    verifiedEpisodeCount: z.int().positive(),
    isLive: z.boolean(),
  }),
  "launch.returned": z.strictObject({ ...launch, reasonCodes: z.array(z.string()) }),
};
