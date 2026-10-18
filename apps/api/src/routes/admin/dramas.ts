import {
  adminDramaList,
  adminDramaCreate,
  adminDramaSummary,
  adminDramaGet,
  adminDramaActivityList,
  adminDramaBasicUpdate,
  adminDramaCommercialUpdate,
  adminDramaCastReplace,
  adminDramaDelist,
  adminDramaDramaEpisodeList,
  adminDramaDramaPermitList,
  adminDramaDramaPermitCreate,
  adminDramaListingChecksGet,
  adminDramaMediaReadinessGet,
  adminDramaShelve,
  adminDramaTrailerReplace,
  adminDramaEpisodeUpdate,
  adminDramaPermitUpdate,
  adminDramaPermitRetire,
  adminDramaConfirmPermitRecheck,
  adminDramaCopyrightReplace,
  adminDramaDramaCopyrightRevisionCreate,
} from "@liyoxi/contract";
import type { ContentAdminActor } from "@liyoxi/services";
import type { Context } from "hono";
import type { ApiEnv } from "../../context.js";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";
import type { AdminStaff } from "../../routing/admin.js";
export function contentActor(c: Context<ApiEnv>, staff: AdminStaff): ContentAdminActor {
  if (!c.var.identity) throw new Error("内容管理缺少身份上下文");
  return { identity: c.var.identity, staff: staff.ctx };
}
const edit = { module: "drama", need: "edit" } as const;
export const adminDramaHandlers = [
  defineAdminHandler(adminDramaList, { module: "drama", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.contentAdmin.list(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminDramaSummary, { module: "drama", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(c, await c.var.runtime.contentAdmin.summary(staff.ctx, c.req.valid("query")));
  }),
  defineAdminHandler(adminDramaGet, { module: "drama", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.get(contentActor(c, staff), c.req.valid("param").dramaId),
    );
  }),
  defineAdminHandler(
    adminDramaActivityList,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.activities(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
          c.req.valid("query"),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminDramaDramaEpisodeList,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.episodes(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
          c.req.valid("query"),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminDramaDramaPermitList,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.permits(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
          c.req.valid("query"),
        ),
      );
    },
  ),
  defineAdminHandler(
    adminDramaListingChecksGet,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.listingChecks(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
        ),
      );
    },
  ),
  defineAdminHandler(
    adminDramaMediaReadinessGet,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.mediaReadiness(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
        ),
      );
    },
  ),
  defineAdminHandler(adminDramaCreate, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.create(contentActor(c, staff), c.req.valid("json"), {
        idem: idemOf(c),
      }),
    );
  }),
  defineAdminHandler(adminDramaBasicUpdate, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.basic(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaCommercialUpdate, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.commercial(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaCastReplace, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.cast(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaDelist, { module: "drama", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.delist(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaDramaPermitCreate, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.createPermit(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaShelve, { module: "drama", need: "view" }, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.shelve(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(
    adminDramaTrailerReplace,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.trailer(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      );
    },
  ),
  defineAdminHandler(adminDramaEpisodeUpdate, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.updateEpisode(
        contentActor(c, staff),
        c.req.valid("param").dramaEpisodeId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaPermitUpdate, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.updatePermit(
        contentActor(c, staff),
        c.req.valid("param").dramaPermitId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaPermitRetire, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.retirePermit(
        contentActor(c, staff),
        c.req.valid("param").dramaPermitId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaConfirmPermitRecheck, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.confirmPermit(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(adminDramaCopyrightReplace, edit, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      await c.var.runtime.contentAdmin.replace(
        contentActor(c, staff),
        c.req.valid("param").dramaId,
        c.req.valid("json"),
        { idem: idemOf(c) },
      ),
    );
  }),
  defineAdminHandler(
    adminDramaDramaCopyrightRevisionCreate,
    { module: "drama", need: "view" },
    async (c, staff) => {
      c.header("Cache-Control", "no-store");
      return ok(
        c,
        await c.var.runtime.contentAdmin.revise(
          contentActor(c, staff),
          c.req.valid("param").dramaId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      );
    },
  ),
];
