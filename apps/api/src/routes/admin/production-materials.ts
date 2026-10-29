import {
  adminProductionRecordList,
  adminProductionRecordNormalize,
  adminProductionRecordRestamp,
  adminProductionRecordRecheck,
  adminDeliveryTicketMaterialList,
  adminDeliveryTicketMaterialDownloadUrls,
  adminOrderItemDownloadList,
  ProductionRecordPageSchema,
  ProductionJobAcceptedSchema,
  MaterialListSchema,
  MaterialDownloadResultSchema,
  DownloadHistorySchema,
} from "@liyoxi/contract";
import { createRuntimeProductionMaterials, createDownloadRecords } from "@liyoxi/services";
import type { Runtime } from "@liyoxi/services";
import { ok } from "../../http/errors.js";
import { idemOf } from "../../http/idempotency.js";
import { defineAdminHandler } from "../../routing/admin.js";

const materialServices = new WeakMap<
  Runtime,
  ReturnType<typeof createRuntimeProductionMaterials>
>();
const recordServices = new WeakMap<Runtime, ReturnType<typeof createDownloadRecords>>();
function materialsOf(runtime: Runtime) {
  let service = materialServices.get(runtime);
  if (!service) {
    service = createRuntimeProductionMaterials({
      tx: runtime.tx,
      clock: runtime.clock,
      media: runtime.media,
    });
    materialServices.set(runtime, service);
  }
  return service;
}
function recordsOf(runtime: Runtime) {
  let service = recordServices.get(runtime);
  if (!service) {
    service = createDownloadRecords({ tx: runtime.tx, clock: runtime.clock });
    recordServices.set(runtime, service);
  }
  return service;
}
const read = { module: "delivery", need: "view" } as const;

export const adminProductionMaterialsHandlers = [
  defineAdminHandler(adminProductionRecordList, read, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      ProductionRecordPageSchema.parse(
        await c.var.runtime.media.productionActions.list(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("query"),
        ),
      ),
    );
  }),
  defineAdminHandler(adminProductionRecordNormalize, read, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      ProductionJobAcceptedSchema.parse(
        await c.var.runtime.media.productionActions.normalize(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").productionRecordId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminProductionRecordRestamp, read, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      ProductionJobAcceptedSchema.parse(
        await c.var.runtime.media.productionActions.restamp(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").productionRecordId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminProductionRecordRecheck, read, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      ProductionJobAcceptedSchema.parse(
        await c.var.runtime.media.productionActions.recheck(
          { identity: c.var.identity!, staff: staff.ctx },
          c.req.valid("param").productionRecordId,
          c.req.valid("json"),
          { idem: idemOf(c) },
        ),
      ),
    );
  }),
  defineAdminHandler(adminDeliveryTicketMaterialList, read, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      MaterialListSchema.parse(
        await materialsOf(c.var.runtime).list(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
        ),
      ),
    );
  }),
  defineAdminHandler(adminDeliveryTicketMaterialDownloadUrls, read, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      MaterialDownloadResultSchema.parse(
        await materialsOf(c.var.runtime).downloadUrls(
          c.var.identity!,
          staff.ctx,
          c.req.valid("param").deliveryTicketId,
          c.req.valid("json"),
        ),
      ),
    );
  }),
  defineAdminHandler(adminOrderItemDownloadList, read, async (c, staff) => {
    c.header("Cache-Control", "no-store");
    return ok(
      c,
      DownloadHistorySchema.parse(
        await recordsOf(c.var.runtime).list(
          staff.ctx,
          c.req.valid("param").orderItemId,
          c.req.valid("query"),
        ),
      ),
    );
  }),
];
