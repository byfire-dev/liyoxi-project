import { z } from "zod";
import type { Tx } from "../kernel/index.js";
import { AppError } from "../kernel/index.js";

const id = z.uuid();
const key = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      /^[a-z0-9][a-z0-9_./-]*$/.test(value) &&
      !value.includes("..") &&
      !value.startsWith("incoming/"),
  );
const name = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/\p{Cc}]/u.test(value) && value !== "." && value !== "..");
export const ZipItemSchema = z.strictObject({
  fileId: id,
  key,
  name,
  size: z.string().regex(/^[1-9]\d*$/),
  crc64: z.string().regex(/^\d+$/).nullable(),
  etag: z.string().min(1).nullable(),
});
export const ZipInputSchema = z
  .strictObject({
    ownerType: z.literal("delivery_release"),
    ownerId: id,
    entityId: id,
    storeId: id,
    orderItemId: id,
    items: z.array(ZipItemSchema).min(1).max(100),
    publishListText: z.string().nullable(),
    zipFileName: name,
    keepUntil: z.iso.datetime(),
    zipBundleId: id,
    zipGen: z.int().positive(),
  })
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.fileId)).size === value.items.length &&
      new Set(value.items.map((item) => item.name)).size === value.items.length &&
      !value.items.some((item) => item.name === "发布清单.txt") &&
      Buffer.byteLength(value.publishListText ?? "", "utf8") <= 200 * 1024,
  );
export type ZipJobInput = z.infer<typeof ZipInputSchema>;
export type EnsureZipInput = Omit<ZipJobInput, "zipBundleId" | "zipGen" | "keepUntil"> & {
  readonly keepUntil: Date;
};
export interface ZipResult {
  readonly zipBundleId: string | null;
  readonly zipState: "none" | "building" | "failed" | "ready";
  readonly zipGen: number | null;
  readonly zipFileId: string | null;
  readonly publishListFileId: string | null;
}
export const zipKeys = (input: ZipJobInput, job: Readonly<{ id: string; attemptNo: number }>) => {
  const prefix = `pkg/${input.orderItemId}/${input.ownerId}-${input.zipGen}/${job.id}-${job.attemptNo}`;
  return { zip: `${prefix}.zip`, list: `${prefix}.txt` };
};
export async function readZipSourceFiles(
  tx: Tx,
  input: {
    readonly fileIds: readonly string[];
    readonly entityId: string;
    readonly storeId: string;
  },
) {
  const files = await tx.fileObject.findMany({ where: { id: { in: [...input.fileIds] } } });
  if (
    files.length !== new Set(input.fileIds).size ||
    files.some(
      (file) =>
        file.entityId !== input.entityId ||
        file.storeId !== input.storeId ||
        file.bucket !== "media" ||
        file.status !== "stored" ||
        file.moderationState === "block" ||
        file.sizeBytes === null,
    )
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  return files.map((file) => ({
    fileId: file.id,
    key: file.objectKey,
    size: file.sizeBytes!.toString(),
    crc64: file.crc64,
    etag: file.etag,
  }));
}
export async function zipSourcesCurrent(tx: Tx, input: ZipJobInput) {
  try {
    const files = await readZipSourceFiles(tx, {
      fileIds: input.items.map((item) => item.fileId),
      entityId: input.entityId,
      storeId: input.storeId,
    });
    return input.items.every((item) =>
      files.some(
        (file) =>
          file.fileId === item.fileId &&
          file.key === item.key &&
          file.size === item.size &&
          file.etag === item.etag &&
          (item.crc64 === null || file.crc64 === item.crc64),
      ),
    );
  } catch {
    return false;
  }
}
