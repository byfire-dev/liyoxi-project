import { lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import { link } from "./refs.js";
import { jobBudget } from "./jobs/policy.js";
import { ZipInputSchema } from "./zip-types.js";
import type { EnsureZipInput, ZipResult } from "./zip-types.js";

export async function ensureZip(
  deps: BoundMediaDeps,
  tx: Tx,
  input: EnsureZipInput,
  options: { readonly retry?: boolean; readonly peek?: boolean } = {},
): Promise<ZipResult> {
  const where = { ownerType_ownerId: { ownerType: input.ownerType, ownerId: input.ownerId } };
  let bundle = await tx.zipBundle.findUnique({ where });
  const result = (zipState: ZipResult["zipState"]): ZipResult => ({
    zipBundleId: bundle?.id ?? null,
    zipGen: bundle?.zipGen ?? null,
    zipState,
    zipFileId: zipState === "ready" ? bundle!.zipFileId : null,
    publishListFileId: zipState === "ready" ? bundle!.publishListFileId : null,
  });
  if (!bundle && options.peek) return result("none");
  const now = deps.clock.now();
  if (!bundle) {
    await tx.zipBundle.createMany({
      data: [
        {
          id: uuidv7(),
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          zipState: "none",
          zipGen: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    bundle = await tx.zipBundle.findUniqueOrThrow({ where });
  }
  await lockRows(tx, "zip_bundle", [bundle.id]);
  bundle = await tx.zipBundle.findUniqueOrThrow({ where });
  if (bundle.zipState === "ready") {
    await lockRows(tx, "file_object", [
      bundle.zipFileId!,
      ...(bundle.publishListFileId ? [bundle.publishListFileId] : []),
    ]);
    const file = await tx.fileObject.findUnique({ where: { id: bundle.zipFileId! } });
    if (file?.status === "stored" && file.moderationState !== "block") {
      let listAvailable = bundle.publishListFileId === null;
      for (const [fileId, role] of [
        [bundle.zipFileId, "zip"],
        [bundle.publishListFileId, "list"],
      ] as const) {
        if (fileId) {
          const stored = await tx.fileObject.findUnique({ where: { id: fileId } });
          if (stored?.status === "stored" && stored.moderationState !== "block") {
            if (role === "list") listAvailable = true;
            await link(deps, tx, {
              fileId,
              refType: "zip_bundle",
              refId: bundle.id,
              role,
              entityId: input.entityId,
              storeId: input.storeId,
              released: true,
              keepUntil: input.keepUntil,
            });
          }
        }
      }
      return {
        ...result("ready"),
        publishListFileId: listAvailable ? bundle.publishListFileId : null,
      };
    }
    if (options.peek) return result("none");
  } else if (
    options.peek ||
    bundle.zipState === "building" ||
    (bundle.zipState === "failed" && !options.retry)
  )
    return result(bundle.zipState as ZipResult["zipState"]);
  const zipGen = bundle.zipGen + 1;
  const value = ZipInputSchema.parse({
    ...input,
    keepUntil: input.keepUntil.toISOString(),
    zipBundleId: bundle.id,
    zipGen,
  });
  await tx.mediaJob.create({
    data: {
      id: uuidv7(),
      kind: "zip_package",
      provider: deps.zipProvider?.status ?? "unconfigured",
      mode: "remote",
      subjectType: "zip_bundle",
      subjectId: bundle.id,
      parentType: "zip_bundle",
      parentId: bundle.id,
      dedupeKey: `zip:${bundle.id}:${zipGen}`,
      input: value,
      state: "queued",
      maxAttempts: 3,
      nextRunAt: now,
      deadlineAt: new Date(now.getTime() + jobBudget("zip_package")!.deadlineMs),
      createdAt: now,
      updatedAt: now,
    },
  });
  bundle = await tx.zipBundle.update({
    where,
    data: {
      zipState: "building",
      zipGen,
      zipFileId: null,
      publishListFileId: null,
      updatedAt: now,
    },
  });
  return result("building");
}

export const zipRefType = {
  // Cache columns are evidence, not live-use holds; released refs alone govern expiry.
  inUse: async () => [],
  roles: {
    zip: { categories: ["package_zip"] as const, retentionDays: 0 },
    list: { categories: ["publish_list"] as const, retentionDays: 0 },
  },
  readColumns: async (tx: Tx) =>
    (await tx.zipBundle.findMany({ where: { zipState: "ready" } })).flatMap((row) => [
      ...(row.zipFileId ? [{ fileId: row.zipFileId, refId: row.id, role: "zip" }] : []),
      ...(row.publishListFileId
        ? [{ fileId: row.publishListFileId, refId: row.id, role: "list" }]
        : []),
    ]),
};
