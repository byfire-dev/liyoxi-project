import { z } from "@liyoxi/contract";
import type { WorkerServices } from "@liyoxi/services";
const refSchema = z.strictObject({ revisionId: z.uuid() });
/** Queue transports identifiers only. All business/lease/IO work belongs to services. */
export const consumeDocs = (services: WorkerServices, raw: unknown) =>
  services.renderLicenseRevision(refSchema.parse(raw));
