import { randomUUID } from "node:crypto";

// NodeNext：相对导入带 .js 后缀；只当类型用的要写 import type
import type { Amount } from "./money.js";
import { add } from "./money.js";

export function total(amounts: readonly Amount[]): Amount {
  return amounts.reduce(add, { fen: 0 });
}

export const requestId: string = randomUUID();
