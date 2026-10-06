import { createHash } from "node:crypto";
import { IdSchema } from "@liyoxi/contract";
export interface OrderCursor {
  group: number;
  at: string | null;
  id: string;
}
export function cursorScope(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function decodeCursor(value: string | undefined, scope: string): OrderCursor | null {
  try {
    if (!value) return null;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as Record<
      string,
      unknown
    >;
    if (
      parsed.scope !== scope ||
      !IdSchema.safeParse(parsed.id).success ||
      !Number.isInteger(parsed.group) ||
      Number(parsed.group) < 0 ||
      Number(parsed.group) > 2 ||
      !(
        parsed.at === null ||
        (typeof parsed.at === "string" &&
          /^\d{4}-\d{2}-\d{2}T/.test(parsed.at) &&
          Number.isFinite(Date.parse(parsed.at)))
      )
    )
      return null;
    return { group: Number(parsed.group), at: parsed.at as string | null, id: String(parsed.id) };
  } catch {
    return null;
  } // C42：损坏或不属于本筛选的游标回到第一页。
}
export function encodeCursor(value: OrderCursor, scope: string) {
  return Buffer.from(JSON.stringify({ ...value, scope })).toString("base64url");
}
