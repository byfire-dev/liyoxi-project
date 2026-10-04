import { basename } from "node:path";

const parts: string[] = ["a/b.txt"];
// noUncheckedIndexedAccess：下标访问的结果带 undefined
const first: string | undefined = parts[0];

export const name: string = basename(first ?? "");
