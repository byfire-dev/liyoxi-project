import {
  adminHomeBannerList,
  adminHomeBannerSummary,
  adminHomeBannerCreate,
  adminHomeBannerUpdate,
  adminHomeBannerBatchReorder,
  adminSiteConfigGet,
  adminSiteConfigDraftReplace,
  adminSiteConfigPublish,
  adminSiteConfigRevisionList,
  adminSiteNoticeList,
} from "@liyoxi/contract";
import { defineAdminHandler } from "../../routing/admin.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { configActor, configError } from "./system-config-context.js";
const view = { module: "ops", need: "view" } as const,
  edit = { module: "ops", need: "edit" } as const;
async function response<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    return configError(error);
  }
}
export const siteHandlers = [
  defineAdminHandler(adminSiteConfigGet, view, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.get(configActor(c, staff), c.req.valid("param").configKey),
      ),
    ),
  ),
  defineAdminHandler(adminSiteConfigDraftReplace, edit, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.replaceDraft(
          configActor(c, staff),
          c.req.valid("param").configKey,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminSiteConfigPublish, edit, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.publish(
          configActor(c, staff),
          c.req.valid("param").configKey,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminSiteConfigRevisionList, view, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.revisions(
          configActor(c, staff),
          c.req.valid("param").configKey,
          c.req.valid("query"),
        ),
      ),
    ),
  ),
  defineAdminHandler(adminHomeBannerList, view, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.banners.list(configActor(c, staff), c.req.valid("query")),
      ),
    ),
  ),
  defineAdminHandler(adminHomeBannerSummary, view, async (c, staff) =>
    ok(c, await response(() => c.var.runtime.siteAdmin.banners.summary(configActor(c, staff)))),
  ),
  defineAdminHandler(adminHomeBannerCreate, edit, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.banners.create(configActor(c, staff), c.req.valid("json"), {
          idem: idemOf(c),
        }),
      ),
    ),
  ),
  defineAdminHandler(adminHomeBannerUpdate, edit, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.banners.update(
          configActor(c, staff),
          c.req.valid("param").homeBannerId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    ),
  ),
  defineAdminHandler(adminHomeBannerBatchReorder, edit, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.banners.reorder(configActor(c, staff), c.req.valid("json"), {
          idem: idemOf(c),
        }),
      ),
    ),
  ),
  defineAdminHandler(adminSiteNoticeList, null, async (c, staff) =>
    ok(
      c,
      await response(() =>
        c.var.runtime.siteAdmin.notices(configActor(c, staff), c.req.valid("query")),
      ),
    ),
  ),
];
