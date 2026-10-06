import type { z } from "zod";
import {
  mStoreProfileGet,
  mStoreProfileBasicGet,
  mStoreProfileBasicUpdate,
  mStoreProfileMediaGet,
  mStoreProfileMediaUpdate,
  mStoreProfileServiceGet,
  mStoreProfileServiceUpdate,
  mStoreProfileQualificationGet,
  mStoreProfileQualificationUpdate,
  mStoreProfileContactUpdate,
  mStoreProfileQualificationSubmit,
  mQualificationDocCreate,
  mQualificationDocUpdate,
  StoreProfileOverviewOwnerSchema,
  StoreProfileOverviewClerkSchema,
  StoreProfileBasicOwnerSchema,
  StoreProfileBasicClerkSchema,
  StoreProfileMediaOwnerSchema,
  StoreProfileMediaClerkSchema,
  StoreProfileServiceOwnerSchema,
  StoreProfileServiceClerkSchema,
  QualificationViewOwnerSchema,
  QualificationViewClerkSchema,
  QualificationDocRecognizedSchema,
  QualificationDocUpdateResultSchema,
  ContactViewSchema,
} from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import type { ProfileViewer } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../context.js";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { respondByRole } from "../http/respond-by-role.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

function viewerOf(c: Context<ApiEnv>): ProfileViewer {
  const ctx = c.get("identity"),
    membership = c.get("membership"),
    principal = c.get("merchantSession");
  if (!ctx || !membership || !principal) throw new AppError("NOT_A_MEMBER");
  return { ctx, membership, principal };
}
const profileOf = (c: Context<ApiEnv>) => merchantServicesOf(c.var.runtime).profile;
const noStore = (c: Context<ApiEnv>) => c.header("Cache-Control", "no-store");
const basicSaved =
  mStoreProfileBasicUpdate.responses[200].content["application/json"].schema.shape.data;
const mediaSaved =
  mStoreProfileMediaUpdate.responses[200].content["application/json"].schema.shape.data;
const serviceSaved =
  mStoreProfileServiceUpdate.responses[200].content["application/json"].schema.shape.data;
const qualificationSaved =
  mStoreProfileQualificationUpdate.responses[200].content["application/json"].schema.shape.data;
const qualificationSubmitted =
  mStoreProfileQualificationSubmit.responses[200].content["application/json"].schema.shape.data;
export const profileHandlers = [
  defineHandler(mStoreProfileGet, async (c) => {
    noStore(c);
    return respondByRole<
      | z.infer<typeof StoreProfileOverviewOwnerSchema>
      | z.infer<typeof StoreProfileOverviewClerkSchema>
    >(
      c,
      { owner: StoreProfileOverviewOwnerSchema, clerk: StoreProfileOverviewClerkSchema },
      await profileOf(c).get(viewerOf(c)),
    );
  }),
  defineHandler(mStoreProfileBasicGet, async (c) => {
    noStore(c);
    return respondByRole<
      z.infer<typeof StoreProfileBasicOwnerSchema> | z.infer<typeof StoreProfileBasicClerkSchema>
    >(
      c,
      { owner: StoreProfileBasicOwnerSchema, clerk: StoreProfileBasicClerkSchema },
      await profileOf(c).basic(viewerOf(c)),
    );
  }),
  defineHandler(mStoreProfileBasicUpdate, async (c) =>
    respondByRole<z.infer<typeof basicSaved>>(
      c,
      { owner: basicSaved },
      await profileOf(c).updateBasic(viewerOf(c), c.req.valid("json"), { idem: idemOf(c) }),
    ),
  ),
  defineHandler(mStoreProfileMediaGet, async (c) => {
    noStore(c);
    return respondByRole<
      z.infer<typeof StoreProfileMediaOwnerSchema> | z.infer<typeof StoreProfileMediaClerkSchema>
    >(
      c,
      { owner: StoreProfileMediaOwnerSchema, clerk: StoreProfileMediaClerkSchema },
      await profileOf(c).media(viewerOf(c)),
    );
  }),
  defineHandler(mStoreProfileMediaUpdate, async (c) =>
    respondByRole<z.infer<typeof mediaSaved>>(
      c,
      { owner: mediaSaved },
      await profileOf(c).updateMedia(viewerOf(c), c.req.valid("json"), { idem: idemOf(c) }),
    ),
  ),
  defineHandler(mStoreProfileServiceGet, async (c) => {
    noStore(c);
    return respondByRole<
      | z.infer<typeof StoreProfileServiceOwnerSchema>
      | z.infer<typeof StoreProfileServiceClerkSchema>
    >(
      c,
      { owner: StoreProfileServiceOwnerSchema, clerk: StoreProfileServiceClerkSchema },
      await profileOf(c).service(viewerOf(c)),
    );
  }),
  defineHandler(mStoreProfileServiceUpdate, async (c) =>
    respondByRole<z.infer<typeof serviceSaved>>(
      c,
      { owner: serviceSaved },
      await profileOf(c).updateService(viewerOf(c), c.req.valid("json"), { idem: idemOf(c) }),
    ),
  ),
  defineHandler(mStoreProfileQualificationGet, async (c) => {
    noStore(c);
    return respondByRole<
      z.infer<typeof QualificationViewOwnerSchema> | z.infer<typeof QualificationViewClerkSchema>
    >(
      c,
      { owner: QualificationViewOwnerSchema, clerk: QualificationViewClerkSchema },
      await profileOf(c).qualification(viewerOf(c)),
    );
  }),
  defineHandler(mStoreProfileQualificationUpdate, async (c) =>
    respondByRole<z.infer<typeof qualificationSaved>>(
      c,
      { owner: qualificationSaved },
      await profileOf(c).updateQualification(viewerOf(c), c.req.valid("json"), { idem: idemOf(c) }),
    ),
  ),
  defineHandler(mStoreProfileContactUpdate, async (c) =>
    ok(
      c,
      ContactViewSchema.parse(
        await profileOf(c).updateContact(viewerOf(c), c.req.valid("json"), { idem: idemOf(c) }),
      ),
    ),
  ),
  defineHandler(mStoreProfileQualificationSubmit, async (c) =>
    respondByRole<z.infer<typeof qualificationSubmitted>>(
      c,
      { owner: qualificationSubmitted },
      await profileOf(c).submit(viewerOf(c), c.req.valid("json"), { idem: idemOf(c) }),
    ),
  ),
  defineHandler(mQualificationDocCreate, async (c) =>
    ok(
      c,
      QualificationDocRecognizedSchema.parse(
        await profileOf(c).createDocument(viewerOf(c), c.req.valid("json"), { idem: idemOf(c) }),
      ),
    ),
  ),
  defineHandler(mQualificationDocUpdate, async (c) =>
    ok(
      c,
      QualificationDocUpdateResultSchema.parse(
        await profileOf(c).updateDocument(
          viewerOf(c),
          c.req.valid("param").qualificationDocId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
];
