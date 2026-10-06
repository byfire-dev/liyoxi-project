import type { InvariantViolation, Tx } from "../kernel/index.js";
import type { FileRefType } from "./ports.js";
let refTypes: ReadonlyMap<string, FileRefType> = new Map();
export function bindFileRefTypes(types: ReadonlyMap<string, FileRefType>) {
  refTypes = types;
}
export async function findI2Violations(tx: Tx): Promise<InvariantViolation[]> {
  const rows = await tx.fileObject.findMany({
    where: { status: { not: "stored" }, fileRefs: { some: { state: "live" } } },
    select: { id: true, entityId: true },
  });
  return rows.map((row) => ({
    subject: { type: "file_object", id: row.id },
    ...(row.entityId ? { entityId: row.entityId } : {}),
    detail: { problem: "非 stored 文件存在 live 引用" },
  }));
}
export async function findI14Violations(tx: Tx, types = refTypes): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  for (const [refType, definition] of types) {
    for (const expected of (await definition.readColumns?.(tx)) ?? []) {
      if (
        !(await tx.fileRef.findUnique({
          where: {
            fileId_refType_refId_role: {
              fileId: expected.fileId,
              refType,
              refId: expected.refId,
              role: expected.role,
            },
          },
        }))
      ) {
        const file = await tx.fileObject.findUnique({
          where: { id: expected.fileId },
          select: { entityId: true },
        });
        violations.push({
          subject: { type: "file_object", id: expected.fileId },
          ...(file?.entityId ? { entityId: file.entityId } : {}),
          detail: {
            problem: "业务列缺文件引用",
            refType,
            refId: expected.refId,
            role: expected.role,
          },
        });
      }
    }
  }
  return violations;
}
